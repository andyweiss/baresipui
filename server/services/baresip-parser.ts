import type { StateManager } from './state-manager';
import type { BaresipEvent, BaresipCommandResponse, CallInfo } from '~/types';
import { dtmfToGpio, gpioToDtmf } from '~/types';
import { getBaresipConnection } from './baresip-connection';
import { recordRegistrationEvent, recordCallStarted, recordCallEnded, recordAlsaError, recordJbufDrop } from './prometheus';

export type BaresipResponseObserver = (
  response: BaresipCommandResponse,
) => void | Promise<void>;
export type BaresipEventObserver = (
  event: BaresipEvent,
) => void | Promise<void>;

const responseObservers = new Set<BaresipResponseObserver>();
const eventObservers = new Set<BaresipEventObserver>();

export function registerBaresipResponseObserver(
  observer: BaresipResponseObserver,
): () => void {
  responseObservers.add(observer);
  return () => responseObservers.delete(observer);
}

export function registerBaresipEventObserver(
  observer: BaresipEventObserver,
): () => void {
  eventObservers.add(observer);
  return () => eventObservers.delete(observer);
}

function notifyObservers<T>(
  observers: Set<(value: T) => void | Promise<void>>,
  value: T,
  kind: string,
): void {
  for (const observer of observers) {
    try {
      void Promise.resolve(observer(value)).catch((error) => {
        console.error(`Baresip ${kind} observer failed:`, error);
      });
    } catch (error) {
      console.error(`Baresip ${kind} observer failed:`, error);
    }
  }
}

// Global queue to serialize auto-connect operations
let autoConnectQueue: Array<() => void> = [];
let isProcessingAutoConnect = false;

// Deduplication: track which account URIs are already in the queue to prevent double-dial
const queuedAccountUris = new Set<string>();

// Per-account cooldown: prevent dialing the same account more than once per second
// (backup guard in case queue deduplication is bypassed by rapid state changes)
const lastDialTime = new Map<string, number>();
const DIAL_COOLDOWN_MS = 1500;

function processAutoConnectQueue() {
  if (isProcessingAutoConnect || autoConnectQueue.length === 0) {
    return;
  }

  isProcessingAutoConnect = true;
  const next = autoConnectQueue.shift();

  if (next) {
    next();
    // Wait for the operation to complete before processing next
    setTimeout(() => {
      isProcessingAutoConnect = false;
      processAutoConnectQueue();
    }, 500); // Wait 500ms between auto-connect operations
  } else {
    isProcessingAutoConnect = false;
  }
}

// Buffered version: accepts a string buffer, parses all complete netstrings,
// returns remaining unconsumed bytes (incomplete netstring at end).
// All messages processed synchronously to preserve correct event ordering.
export function parseBaresipEventBuffered(buffer: string, stateManager: StateManager): { remaining: string } {
  let remaining = buffer;

  while (remaining.length > 0) {
    const colonIndex = remaining.indexOf(':');
    if (colonIndex === -1) break; // No complete length prefix yet

    const length = parseInt(remaining.substring(0, colonIndex), 10);
    if (isNaN(length) || length < 0) {
      // Corrupt data - skip one character and retry
      remaining = remaining.substring(1);
      continue;
    }

    const startIndex = colonIndex + 1;
    const endIndex = startIndex + length;

    // Not enough data yet - wait for more TCP chunks
    if (remaining.length < endIndex + 1) break;

    // Validate trailing comma
    if (remaining[endIndex] !== ',') {
      // Corrupt frame - skip one character and retry
      remaining = remaining.substring(1);
      continue;
    }

    const messageStr = remaining.substring(startIndex, endIndex);
    remaining = remaining.substring(endIndex + 1);

    // Process synchronously - ordering is critical for correct state
    try {
      const jsonMessage = JSON.parse(messageStr);
      if (jsonMessage.response !== undefined) {
        // Correlated command promises must resolve only after their response
        // has been fully applied to state (notably listcalls inventory).
        handleCommandResponse(jsonMessage, stateManager);
        notifyObservers(responseObservers, jsonMessage, 'response');
      } else if (jsonMessage.event) {
        handleJsonEvent(jsonMessage, stateManager);
      }
    } catch (e) {
      handleTextLine(messageStr, stateManager);
    }
  }

  return { remaining };
}

function handleCommandResponse(response: BaresipCommandResponse, stateManager: StateManager): void {
  const timestamp = Date.now();

  // Successful correlated commands with empty payloads (e.g. DTMF after callfind)
  // are already delivered to their waiters; nothing remains to parse.
  if (
    response.ok &&
    response.token &&
    (response.data === undefined ||
      response.data === null ||
      response.data === '')
  ) {
    return;
  }

  //  Dispatch-Logic for different response types
  if (typeof response.data === 'string') {
    const data = response.data;
    const trimmed = data.trim();

    // Check if this is getrtcpstats JSON response
    if (data.includes('call_id') && data.startsWith('[')) {
      try {
        parseGetRtcpStatsResponse(data, stateManager);
        return;
      } catch (e) {
        // Silently ignore parse errors
      }
    }

    // mediasoup_bridge module command JSON (ms_ctx_* / ms_bridge_* / ms_src_*)
    if (trimmed.startsWith('{') && trimmed.includes('"key"')) {
      try {
        const payload = JSON.parse(trimmed) as unknown;
        if (isMediasoupBridgeCommandPayload(payload)) {
          parseMediasoupBridgeCommandResponse(payload, stateManager);
          return;
        }
      } catch {
        // Fall through to other handlers / unhandled warning.
      }
    }

    // Dynamic module load acknowledgement used by the talktome bridge plugin.
    if (/^loaded module\b/i.test(trimmed)) {
      stateManager.addLog('info', 'tcp-socket', trimmed);
      return;
    }

    // callfind / call-selection text used before DTMF GPIO and tally digits.
    if (
      /^ua:\s*sip:/im.test(trimmed) ||
      /^call uri:/im.test(trimmed) ||
      /^setting current call:/im.test(trimmed)
    ) {
      return;
    }
    
    // 1. System Info
    if (data.includes('--- System info: ---')) {
      parseSysinfoResponse(response, stateManager, timestamp);
      return;
    }
    // 2. Contacts
    if (data.includes('--- Contacts')) {
      parseContactsFromResponse(data, stateManager);
      return;
    }
    // 2b. Presence timestamps (from presence_ts command)
    if (data.includes('Presence status with timestamps:')) {
      parsePresenceTimestamps(data, stateManager);
      return;
    }
    // 3. Callstats (MUST check BEFORE calls pattern!)
    if (data.includes('Call debug') || data.includes('audio RTP')) {
      parseCallStatResponse(data, stateManager);
      return;
    }
    // 4. Calls - Active call queries
    // Matches: "Active calls (1)", "Active calls (0)", "no active call", "no calls"
    // Purpose: Query current call state from baresip (e.g., after UI reconnect)
    // Strategy: Last wins for updates - listcalls ADDS/UPDATES but does NOT remove
    //           (Events like CALL_CLOSED handle removal in real-time)
    if ((data.toLowerCase().includes('active calls') ||
        data.toLowerCase().includes('no active call') || 
        data.toLowerCase().includes('no calls')) &&
        !data.includes('Call debug')) {
      parseCallsResponse(data, stateManager, false);
      return;
    }
    // 5. uastat -> Account status with full SIP status codes (--- sip:... --- blocks)
    if (data.includes('--- sip:') && data.includes('Account:')) {
      parseAccountStatusResponse(data, stateManager);
      return;
    }
  }
  
  // Fallback: Log unhandled command response as warning with full response data
  const responseText = response.data || JSON.stringify(response);
  stateManager.addLog('warn', 'tcp-socket', `Unhandled Command Response: ${responseText}`, undefined, response);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * mediasoup_bridge ctrl_tcp commands always return a JSON object with `key`.
 * Discriminate on the stable fields emitted by commands.c.
 */
function isMediasoupBridgeCommandPayload(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key) {
    return false;
  }
  if (typeof value.error === 'string') return true;
  if (value.tx === 'configured') return true;
  if (isRecord(value.tx) && 'packets' in value.tx) return true;
  if (typeof value.mixMode === 'string') return true;
  if (typeof value.muted === 'boolean') return true;
  if (typeof value.producerId === 'string') return true;
  if (typeof value.created === 'boolean') return true;
  if (
    value.state === 'open' ||
    value.state === 'closed' ||
    value.state === 'active' ||
    value.state === 'removed'
  ) {
    return true;
  }
  return false;
}

function parseMediasoupBridgeCommandResponse(
  payload: Record<string, unknown>,
  stateManager: StateManager,
): void {
  const key = String(payload.key);
  if (typeof payload.error === 'string' && payload.error) {
    stateManager.addLog(
      'warn',
      'mediasoup-bridge',
      `mediasoup ${key}: ${payload.error}`,
      undefined,
      payload,
    );
    return;
  }

  // Periodic ms_bridge_stat replies are high-frequency; keep a compact debug
  // line and omit the full payload so Socket.IO logBatch does not rebroadcast
  // large JSON objects every poll interval.
  if (isRecord(payload.tx) && 'packets' in payload.tx) {
    const tx = payload.tx;
    const packets = typeof tx.packets === 'number' ? tx.packets : '?';
    const level =
      typeof tx.levelDbfs === 'number' ? `${tx.levelDbfs.toFixed(1)} dBFS` : '?';
    const muted = tx.muted === true ? ' muted' : '';
    const calls = typeof payload.calls === 'number' ? payload.calls : '?';
    const rx =
      typeof payload.rxSourceCount === 'number' ? payload.rxSourceCount : '?';
    stateManager.addLog(
      'debug',
      'mediasoup-bridge',
      `mediasoup ${key}: stat calls=${calls} tx_packets=${packets} level=${level}${muted} rx_sources=${rx}`,
    );
    return;
  }

  if (payload.tx === 'configured') {
    const localPort =
      typeof payload.localPort === 'number' ? payload.localPort : '?';
    stateManager.addLog(
      'info',
      'mediasoup-bridge',
      `mediasoup ${key}: tx configured localPort=${localPort}`,
      undefined,
      payload,
    );
    return;
  }

  if (typeof payload.muted === 'boolean') {
    stateManager.addLog(
      'info',
      'mediasoup-bridge',
      `mediasoup ${key}: tx ${payload.muted ? 'muted' : 'unmuted'}`,
      undefined,
      payload,
    );
    return;
  }

  if (typeof payload.mixMode === 'string') {
    const bitrate =
      typeof payload.bitrateBps === 'number' ? payload.bitrateBps : '?';
    stateManager.addLog(
      'info',
      'mediasoup-bridge',
      `mediasoup ${key}: config mixMode=${payload.mixMode} bitrateBps=${bitrate}`,
      undefined,
      payload,
    );
    return;
  }

  if (typeof payload.producerId === 'string') {
    const producerId = payload.producerId;
    const state =
      typeof payload.state === 'string' ? payload.state : undefined;
    const localRecvPort =
      typeof payload.localRecvPort === 'number'
        ? payload.localRecvPort
        : undefined;
    if (state === 'removed') {
      stateManager.addLog(
        'info',
        'mediasoup-bridge',
        `mediasoup ${key}: source ${producerId} removed`,
        undefined,
        payload,
      );
      return;
    }
    if (state === 'active') {
      stateManager.addLog(
        'info',
        'mediasoup-bridge',
        `mediasoup ${key}: source ${producerId} active` +
          (localRecvPort !== undefined ? ` recvPort=${localRecvPort}` : ''),
        undefined,
        payload,
      );
      return;
    }
    stateManager.addLog(
      'info',
      'mediasoup-bridge',
      `mediasoup ${key}: source ${producerId} reserved` +
        (localRecvPort !== undefined ? ` recvPort=${localRecvPort}` : ''),
      undefined,
      payload,
    );
    return;
  }

  if (payload.state === 'open' || payload.state === 'closed') {
    const created =
      typeof payload.created === 'boolean'
        ? payload.created
          ? ' created'
          : ' reused'
        : '';
    stateManager.addLog(
      'info',
      'mediasoup-bridge',
      `mediasoup ${key}: context ${payload.state}${created}`,
      undefined,
      payload,
    );
    return;
  }

  stateManager.addLog(
    'info',
    'mediasoup-bridge',
    `mediasoup ${key}: ok`,
    undefined,
    payload,
  );
}

// ************ System Info response Parser ************
function parseSysinfoResponse(response: BaresipCommandResponse, stateManager: StateManager, timestamp: number): void {
  if (response.data && typeof response.data === 'string') {
    // Example sysinfo response:
    // --- System info: ---
    //  Machine:  x86_64/Linux
    //  Version:  4.4.0 (libre v4.4.0)
    //  Build:    64-bit little endian
    //  Kernel:   Linux ...
    //  Uptime:   23 hours 27 mins 45 secs
    //  Started:  Sat Jan  3 21:14:30 2026
    //  Compiler: ...
    //  OpenSSL:  ...
    const lines = response.data.split('\n');
    let version = '';
    let uptime = '';
    let started = '';
    for (const line of lines) {
      if (line.trim().startsWith('Version:')) {
        version = line.split('Version:')[1]?.trim() || '';
      }
      if (line.trim().startsWith('Uptime:')) {
        const uptimeValue = line.split('Uptime:')[1]?.trim() || '';
        // Handle empty uptime (baresip just started or parsing issue)
        uptime = uptimeValue || 'just started';
      }
      if (line.trim().startsWith('Started:')) {
        started = line.split('Started:')[1]?.trim() || '';
      }
    }
    
    stateManager.setBaresipInfo({ version, uptime, started });
  }
}

// ************ Account status response uastat Parser ************
function parseAccountStatusResponse(data: string, stateManager: StateManager): void {
  // Remove ANSI color codes
  const cleanData = data.replace(/\x1b\[[0-9;]*[mK]/g, '');
  // Split into blocks per account
  const blocks = cleanData.split(/--- sip:/g).map(b => b.trim()).filter(Boolean);
  
  for (const block of blocks) {
    // The URI is in the first line of the block
    const lines = block.split('\n').map(l => l.trim());
    const uriMatch = lines[0].match(/^([^\s-]+) ---/);
    const uri = uriMatch ? `sip:${uriMatch[1]}` : `sip:${lines[0].split(' ')[0]}`;
    
    if (!uri) continue; // Skip if no valid URI
    
    // Preserve only call-related state from existing account
    const existingAccount = stateManager.getAccount(uri);
    const account: any = {
      uri,
      registered: false,
      callStatus: existingAccount?.callStatus || 'Idle',
      callId: existingAccount?.callId,
      autoConnectContact: existingAccount?.autoConnectContact,
      autoConnectStatus: existingAccount?.autoConnectStatus || 'Off',
      lastEvent: Date.now(),
      configured: true
    };
    
    // Parse fields
    let displayName = '';
    for (const line of lines) {
      if (line.startsWith('address:')) {
        const addressPart = line.split('address:')[1];
        if (addressPart) {
          account.address = addressPart.trim();
          // Try to extract name from address if no dispname is present
          const addrMatch = account.address.match(/^([^<]+)</);
          if (addrMatch) {
            displayName = addrMatch[1].trim();
          }
        }
      } else if (line.startsWith('luri:')) {
        const luriPart = line.split('luri:')[1];
        if (luriPart) account.luri = luriPart.trim();
      } else if (line.startsWith('aor:')) {
        const aorPart = line.split('aor:')[1];
        if (aorPart) account.aor = aorPart.trim();
      } else if (line.startsWith('dispname:')) {
        const dispnamePart = line.split('dispname:')[1];
        if (dispnamePart) displayName = dispnamePart.trim();
      } else if (line.startsWith('scode:')) {
        const scodePart = line.split('scode:')[1];
        if (!scodePart) continue;
        
        const scode = scodePart.trim();
        account.scode = scode;
        
        if (scode.startsWith('200')) {
          account.registered = true;
          account.registrationError = undefined;
        } else {
          account.registered = false;
          const scodeNum = parseInt(scode);
          
          // Map status codes to user-friendly messages
          if (!isNaN(scodeNum) && scodeNum >= 400 && scodeNum < 700) {
            // Real SIP error codes (4xx, 5xx, 6xx) - always show as-is
            account.registrationError = scode;
          } else if (scodeNum === 0 || scode === '0') {
            // Not initialized yet
            account.registrationError = 'Not registered yet';
          } else if (scodeNum === 999 || scode === '999' || scode.match(/^999\s*\(ERR\)$/i)) {
            // Baresip internal placeholder for pending registration
            account.registrationError = 'Initializing...';
          } else if (scode.includes('fallback')) {
            // Fallback registration mechanism active
            account.registrationError = 'Unknown error';
          } else if (scode.includes('zzz')) {
            // Another baresip placeholder
            account.registrationError = 'Waiting for response...';
          } else if (!scode || scode.trim() === '') {
            // Empty status code
            account.registrationError = 'Status unknown';
          } else {
            // Unknown/other codes - show as-is
            account.registrationError = scode;
          }
        }
      }
    }
    
    if (displayName) {
      account.displayName = displayName;
    }
    
    // Store in StateManager and broadcast
    stateManager.setAccount(uri, account);
    stateManager.broadcast({
      type: 'accountStatus',
      data: account
    });
    
    // Trigger auto-connect check if account is registered and idle
    if (account.registered && account.callStatus === 'Idle') {
      checkAutoConnectForAccount(uri, stateManager);
    }
  }

  // Remove accounts from state that no longer appear in this uastat response
  const seenUris = new Set(blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim());
    const uriMatch = lines[0].match(/^([^\s-]+) ---/);
    return uriMatch ? `sip:${uriMatch[1]}`.toLowerCase() : `sip:${lines[0].split(' ')[0]}`.toLowerCase();
  }));
  for (const existingUri of stateManager.getAccounts().map(a => a.uri.toLowerCase())) {
    if (!seenUris.has(existingUri)) {
      stateManager.removeAccount(existingUri);
    }
  }
}


// ************ Contacts Response Parser ************
function parseContactsFromResponse(data: string, stateManager: StateManager): void {
  // Remove ANSI color codes once for all data
  const cleanData = data.replace(/\x1b\[[0-9;]*[mK]/g, '');
  const lines = cleanData.split('\n');

  let contactCount = 0;
  for (const line of lines) {
    if (!line.includes('<sip:')) continue;

    // Extract SIP URI from format: [spaces] [STATUS] name <sip:...>
    // Status is ignored (comes from presence_ts command)
    const sipMatch = line.match(/<(sip:[^@]+@[^>]+)>/i);
    if (!sipMatch) continue;

    const contact = sipMatch[1];
    
    // Extract name: everything before '<', remove markers, status and whitespace
    const beforeUri = line.substring(0, line.indexOf('<')).trim();
    const name = beforeUri
      .replace(/^[>*]+\s*/, '')  // Remove leading markers like '>' or '*'
      .replace(/^(Unknown|Online|Busy|Offline|Away)\s+/i, '')  // Remove status prefix
      .trim() || contact;

    // Get existing config or create new one
    const existingConfig = stateManager.getContactConfig(contact);
    const contactConfig = {
      name,
      enabled: existingConfig?.enabled || false,
      status: existingConfig?.status || 'Off',
      source: 'api' as const
    };

    // Update contact config (name, etc.) - NO STATUS UPDATE
    stateManager.setContactConfig(contact, contactConfig);
    contactCount++;
  }

  // Broadcast updated contact list if any contacts were found
  if (contactCount > 0) {
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

// ************ Presence Timestamps Parser ************
// Parses presence status with timestamps from baresip's presence_ts command
// Format: sip:user@domain|status|timestamp
// timestamp: Unix timestamp in seconds (0 = no NOTIFY received yet)
function parsePresenceTimestamps(data: string, stateManager: StateManager): void {
  const lines = data.split('\n');
  const PRESENCE_TIMEOUT_SEC = 7200; // 2 hours - SIP SUBSCRIBE cycle is ~3600s, NOTIFY only on change
  let parsedCount = 0;

  for (const line of lines) {
    // Match format: sip:uri|status|timestamp
    const match = line.match(/(sip:[^@]+@[^|]+)\|(\w+)\|(\d+)/);
    if (!match) continue;

    const contact = match[1].trim();
    const status = match[2].toLowerCase();
    const timestamp = parseInt(match[3], 10);
    parsedCount++;

    // Skip if contact has call failure timestamp that's newer than baresip data
    if (stateManager.hasContactCallFailureTimestamp(contact, timestamp)) {
      continue;
    }

    // Handle case: No NOTIFY received yet
    if (timestamp === 0) {
      stateManager.setContactPresence(contact, 'unknown', false);
      continue;
    }

    // Calculate age and determine effective status
    const lastSeenMs = timestamp * 1000;
    const ageInSeconds = Math.floor((Date.now() - lastSeenMs) / 1000);
    const effectiveStatus = ageInSeconds > PRESENCE_TIMEOUT_SEC ? 'unknown' : status;

    // Get previous status for auto-connect detection
    const previousPresence = stateManager.getContactPresence(contact);

    // Update presence data
    stateManager.setContactPresence(contact, effectiveStatus, false);
    stateManager.setContactLastSeen(contact, lastSeenMs);

    // Trigger auto-connect if contact just came online
    if (effectiveStatus === 'online' && previousPresence !== 'online') {
      checkAutoConnectForContact(contact, stateManager);
    }
  }

  // Always broadcast when we processed at least one contact entry
  if (parsedCount > 0) {
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

// Helper: Parse codec parameters from string like "stereo=0;sprop-stereo=1"
function parseCodecParams(paramsString: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (paramsString?.trim()) {
    paramsString.split(';').forEach(p => {
      const [k, v] = p.split('=');
      if (k && v) {
        params[k.trim()] = v.trim();
      }
    });
  }
  return params;
}

// Helper: Parse codec format lines into structured array
function parseCodecFormats(section: string): any[] {
  const codecs: any[] = [];
  const lines = section.split('\n');
  
  for (const line of lines) {
    // Match: "96 opus/48000/2 (params)" 
    const match = line.match(/^\s*(\d+)\s+([A-Za-z0-9-]+)\/(\d+)\/(\d+)\s*(?:\(([^)]*)\))?/);
    if (match) {
      codecs.push({
        payloadType: match[1],
        codec: match[2],
        sampleRate: Number(match[3]),
        channels: Number(match[4]),
        params: parseCodecParams(match[5] || '')
      });
    }
  }
  
  return codecs;
}

// Helper: Build codec updates object from local/remote codec lists
function buildCodecUpdates(localCodecs: any[], remoteCodecs: any[]): any {
  const updates: any = {};
  
  // Find active codec (negotiated between both sides)
  for (const localCodec of localCodecs) {
    const remoteMatch = remoteCodecs.find(rc => 
      rc.codec === localCodec.codec && 
      rc.sampleRate === localCodec.sampleRate && 
      rc.channels === localCodec.channels
    );
    if (remoteMatch) {
      updates.audioCodec = localCodec;
      break;
    }
  }
  
  if (localCodecs.length > 0) {
    updates.txCodecs = localCodecs;
    updates.txAudioCodec = localCodecs[0];
  }
  
  if (remoteCodecs.length > 0) {
    updates.rxCodecs = remoteCodecs;
    updates.rxAudioCodec = remoteCodecs[0];
  }
  
  return updates;
}


// ************ Callstat Parser ************
function parseCallStatResponse(data: string, stateManager: StateManager): void {
  // Extract call ID (uppercase or lowercase hex)
  const callIdMatch = data.match(/id=([a-fA-F0-9]+)/);
  const callId = callIdMatch ? callIdMatch[1] : null;

  // Extract and parse codec sections
  const localFormatsSection = data.split('local formats:')[1]?.split('remote formats:')[0] || '';
  const remoteFormatsSection = data.split('remote formats:')[1]?.split('local attributes:')[0] || '';
  
  const localCodecs = parseCodecFormats(localFormatsSection);
  const remoteCodecs = parseCodecFormats(remoteFormatsSection);
  
  // Build updates object
  const updates = buildCodecUpdates(localCodecs, remoteCodecs);

  // Jitter buffer delay now comes from getrtcpstats (audio_jb_current_value),
  // not from callstat text output.

  // Parse inline RTCP_STATS (may appear in callstat response)
  const rtcpMatch = data.match(/RTCP_STATS:\s*(\{[^\n]+\})/);
  if (rtcpMatch) {
    try {
      const stats = JSON.parse(rtcpMatch[1]);
      updates.audioRxStats = {
        packets: stats.rtp_rx_packets ?? 0,
        packetsLost: stats.rtcp_lost_rx ?? 0,
        jitter: stats.rtcp_jitter_rx_ms ?? 0,
        rtt: stats.rtcp_rtt_ms ?? 0,
        bitrate_kbps: stats.rx_bitrate_kbps ?? 0,
        dropout: stats.rx_dropout ?? false,
        dropout_total: stats.rx_dropout_total ?? 0,
        rtp_rx_errors: stats.rtp_rx_errors ?? 0,
        rtcp_packets: stats.rtcp_rx_packets ?? 0
      };
      updates.audioTxStats = {
        packets: stats.rtp_tx_packets ?? 0,
        packetsLost: stats.rtcp_lost_tx ?? 0,
        jitter: stats.rtcp_jitter_tx_ms ?? 0,
        bitrate_kbps: stats.tx_bitrate_kbps ?? 0,
        rtp_tx_errors: stats.rtp_tx_errors ?? 0,
        rtcp_packets: stats.rtcp_tx_packets ?? 0
      };
    } catch (e) {
      // Silently ignore
    }
  }

  // Parse audio stream line: "audio RTP tx=12345 rx=12345 ..."
  // Fallback RX/TX packet info when no RTCP_STATS available
  if (!updates.audioRxStats) {
    const audioLine = data.match(/audio\s+(?:RTP\s+)?tx=(\d+)\s+rx=(\d+)/i);
    if (audioLine) {
      updates.audioTxStats = { ...updates.audioTxStats, packets: parseInt(audioLine[1]) };
      updates.audioRxStats = { packets: parseInt(audioLine[2]), packetsLost: 0, jitter: 0, bitrate_kbps: 0, dropout: false, dropout_total: 0, rtp_rx_errors: 0 };
    }
  }
  
  // Nothing to update?
  if (Object.keys(updates).length === 0) {
    return;
  }
  
  // Update call with specific ID or fallback to single active call
  if (callId) {
    stateManager.updateCall(callId, updates);
  } else {
    const calls = stateManager.getCalls();
    if (calls.length === 1) {
      stateManager.updateCall(calls[0].callId, updates);
    }
  }
}

function parseGetRtcpStatsResponse(data: string, stateManager: StateManager): void {
  try {
    const stats_array = JSON.parse(data);
    
    if (!Array.isArray(stats_array)) {
      return;
    }
    
    for (const stats of stats_array) {
      const callId = stats.call_id;
      if (!callId) continue;
      
      const call = stateManager.getCall(callId);
      if (!call) continue;
      
      // Update RX stats
      const updates: Partial<CallInfo> = {};
      updates.audioRxStats = {
        packets: stats.rtp_rx_packets ?? 0,
        packetsLost: stats.rtcp_lost_rx ?? 0,
        jitter: stats.rtcp_jitter_rx_ms ?? 0,
        rtt: stats.rtcp_rtt_ms,
        bitrate_kbps: stats.rx_bitrate_kbps ?? 0,
        dropout: stats.rx_dropout ?? false,
        dropout_total: stats.rx_dropout_total ?? 0,
        rtp_rx_errors: stats.rtp_rx_errors ?? 0,
      };
      
      // Update TX stats
      updates.audioTxStats = {
        packets: stats.rtp_tx_packets ?? 0,
        packetsLost: stats.rtcp_lost_tx ?? 0,
        jitter: stats.rtcp_jitter_tx_ms ?? 0,
        bitrate_kbps: stats.tx_bitrate_kbps ?? 0,
        rtp_tx_errors: stats.rtp_tx_errors ?? 0,
      };

      // Jitter buffer delay (from audio_jb_current_value)
      if (stats.jbuf_delay_ms !== undefined) {
        updates.jitterBuffer = {
          current: stats.jbuf_delay_ms ?? 0,
        };
      }

      stateManager.updateCall(callId, updates);
      stateManager.broadcast({ type: 'callUpdated', data: { ...call, ...updates } });
    }
  } catch (error) {
    // Silently ignore parse errors
  }
}

function parseCallsResponse(data: string, stateManager: StateManager, autoReset: boolean = false): void {
  const cleanData = data.replace(/\x1b\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
  const lines = cleanData.split('\n');
  
  // Parse active calls and update account status
  // Actual baresip v3.16 format:
  // User-Agent: <number>@<sip-domain>
  // --- Active calls (1) ---
  // > [line 1, id 8fd950528ad2127d]  1:23:38  ESTABLISHED (on hold) sip:peer@example.com
  //
  // Strategy: Last wins for updates - new info overwrites old
  // - listcalls response ADDS/UPDATES calls found (e.g., on UI reconnect)
  // - BUT does NOT remove calls (unless autoReset=true)
  // - Events (CALL_CLOSED) handle call removal in real-time
  
  const activeCallIds: Set<string> = new Set();
  const accountsWithCalls = new Set<string>();
  let currentUserAgent: string | null = null;
  
  for (const line of lines) {
    // Extract User-Agent (local account)
    const uaMatch = line.match(/User-Agent:\s*(.+@.+)/);
    if (uaMatch) {
      currentUserAgent = `sip:${uaMatch[1].trim()}`;
      continue;
    }
    
    // Skip lines that indicate no calls
    if (line.match(/active calls \(0\)/i) || line.match(/no active calls/i)) {
      continue;
    }
    
    // The current-call marker is optional. Call IDs are opaque and may contain
    // non-hex characters; the optional "(on hold)" field sits before peer URI.
    const callMatch = line.match(
      /^\s*>?\s*\[line\s+\d+\s*,\s*id\s+([^\]]+?)\]\s+\S+\s+([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/i,
    );
    if (callMatch) {
      const callId = callMatch[1].trim();
      const callState = callMatch[2].trim().toUpperCase();
      const details = callMatch[3];
      const remoteMatch = details.match(/<?(sips?:[^>\s]+)>?/i);
      if (!callId || !remoteMatch) continue;
      const remoteUri = remoteMatch[1];
      const onHold = /\(\s*on\s+hold\s*\)/i.test(details);
      const localUri = currentUserAgent;
      
      if (!localUri) {
        continue;
      }
      
      activeCallIds.add(callId);
      accountsWithCalls.add(localUri.toLowerCase().trim());
      
      // Update account call status
      const account = stateManager.getAccount(localUri);
      let callStatus: string;
      let callDirection: 'incoming' | 'outgoing' | 'unknown' = 'unknown';
      if (callState === 'ESTABLISHED') {
        callStatus = 'In Call';
      } else if ([
        'TRYING', 'OUTGOING', 'PROGRESS', 'RINGING', 'EARLY', 'CALLING'
      ].includes(callState)) {
        callStatus = 'Ringing';
      } else {
        callStatus = callState;
      }
      // Direction heuristic: If account has auto-connect, it's outgoing
      if (account && account.autoConnectContact) {
        callDirection = 'outgoing';
      }
      
      // Updates for Account
      const updates: any = { callStatus };
      if (callId) updates.callId = callId;
      if (account && account.autoConnectContact) {
        updates.autoConnectStatus = (callState === 'ESTABLISHED') ? 'Connected' : 'Connecting';
      }
      if (account && localUri) {
        stateManager.updateAccountStatus(String(localUri).toLowerCase().trim(), updates);
      }
      
      // Call object: update if exists, otherwise add
      const existingCall = stateManager.getCall(callId);
      const callObj = {
        callId,
        localUri,
        remoteUri,
        peerName: remoteUri.split('@')[0].replace('sip:', ''),
        state: callState === 'ESTABLISHED' ? 'Established' : 'Ringing',
        onHold,
        direction: existingCall?.direction ?? callDirection,
        startTime: existingCall?.startTime || Date.now(),
        answerTime: callState === 'ESTABLISHED' ? (existingCall?.answerTime || Date.now()) : undefined
      };
      if (existingCall) {
        stateManager.updateCall(callId, callObj);
      } else {
        stateManager.addCall(callObj);
      }
    }
  }
  
  // Auto-Reset only if explicitly enabled (default: disabled)
  if (autoReset) {
    const allAccounts = stateManager.getAccounts();
    
    for (const account of allAccounts) {
      const accountUri = String(account.uri || '').toLowerCase().trim();
      if (!accountsWithCalls.has(accountUri) && account.callStatus !== 'Idle') {
        stateManager.updateAccountStatus(accountUri, { 
          callStatus: 'Idle',
          callId: undefined 
        });
        // Trigger auto-connect check when account becomes idle
        checkAutoConnectForAccount(accountUri, stateManager);
      }
    }
  }
}

/**
 * Handle VU meter events from vumeter_stereo module.
 * Accumulates TX and RX levels per account into a single AudioMeter update.
 *
 * Wire format: param = "{\"l\":-18.2,\"r\":-17.8}"
 */
const vuAccumulator = new Map<string, { txL: number; txR: number; rxL: number; rxR: number }>();

function handleVuMeterEvent(jsonEvent: BaresipEvent, stateManager: StateManager, timestamp: number): void {
  const accountUri = jsonEvent.accountaor;
  if (!accountUri) return;

  // Parse JSON from param — starts with '{' directly from bevent_call_emit
  const param = jsonEvent.param || '';
  const braceIdx = param.indexOf('{');
  if (braceIdx < 0) return;
  const jsonStr = param.substring(braceIdx);

  let levels: { l: number; r: number };
  try {
    levels = JSON.parse(jsonStr);
  } catch {
    return;
  }

  // Get or create accumulator for this account
  let acc = vuAccumulator.get(accountUri);
  if (!acc) {
    acc = { txL: -96, txR: -96, rxL: -96, rxR: -96 };
    vuAccumulator.set(accountUri, acc);
  }

  // Update the relevant direction
  if (jsonEvent.type === 'VU_TX_REPORT') {
    acc.txL = levels.l;
    acc.txR = levels.r;
  } else {
    acc.rxL = levels.l;
    acc.rxR = levels.r;
  }

  // Send combined meter update
  stateManager.updateAudioMeter({
    accountUri,
    txL: acc.txL,
    txR: acc.txR,
    rxL: acc.rxL,
    rxR: acc.rxR,
    timestamp
  });
}

function handleJsonEvent(jsonEvent: BaresipEvent, stateManager: StateManager): void {
  const timestamp = Date.now();
  notifyObservers(eventObservers, jsonEvent, 'event');

  // Handle VU meter events (high-frequency, skip logging)
  if (jsonEvent.type === 'VU_TX_REPORT' || jsonEvent.type === 'VU_RX_REPORT') {
    handleVuMeterEvent(jsonEvent, stateManager, timestamp);
    return;
  }
  if (
    jsonEvent.type === 'MODULE' &&
    jsonEvent.param?.startsWith('mediasoup_bridge,')
  ) {
    // Generic observers consume bridge telemetry; avoid logging its 5 Hz
    // level reports into the ordinary SIP event log.
    return;
  }

  stateManager.addLog('info', 'tcp-socket', `${jsonEvent.class}:${jsonEvent.type}`, undefined, jsonEvent);

  if (jsonEvent.event && jsonEvent.class === 'ua') {
    if (jsonEvent.type === 'REGISTER_OK') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        const account = stateManager.getAccount(uri);
        stateManager.updateAccountStatus(uri, {
          registered: true,
          registrationError: undefined
        });
        recordRegistrationEvent(uri, 'ok');

        // Ensure account is in state and broadcast update
        if (account) {
          stateManager.broadcast({
            type: 'accountStatus',
            data: stateManager.getAccount(uri)
          });
        }
        
        // Check if auto-connect should be triggered immediately
        checkAutoConnectForAccount(uri, stateManager);
      }
    } else if (jsonEvent.type === 'REGISTER_FAIL') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        // Parse error message and remove error code suffix [nnn]
        let errorStatus = 'Registration Error';
        if (jsonEvent.param) {
          const cleanParam = jsonEvent.param.replace(/\s*\[\d+\]\s*$/, '').trim();
          if (cleanParam.length > 0) {
            errorStatus = cleanParam;
          }
        }
        
        // Update account status
        stateManager.updateAccountStatus(uri, {
          registered: false,
          registrationError: errorStatus,
          lastRegistrationAttempt: timestamp
        });
        recordRegistrationEvent(uri, 'fail');
        
        // Broadcast updated account data to ensure UI updates
        const account = stateManager.getAccount(uri);
        if (account) {
          stateManager.broadcast({
            type: 'accountStatus',
            data: account
          });
        }
      }
    } else if (jsonEvent.type === 'UNREGISTERING') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        stateManager.updateAccountStatus(uri, { registered: false });
        
        // Broadcast updated account data
        const account = stateManager.getAccount(uri);
        if (account) {
          stateManager.broadcast({
            type: 'accountStatus',
            data: account
          });
        }
      }
    } else if (jsonEvent.type === 'UA_EVENT' && jsonEvent.event_name === 'account') {
      const uri = jsonEvent.accountaor;
      if (uri && !stateManager.hasAccount(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle' as const,
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        stateManager.setAccount(uri, accountData);

        stateManager.broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  }

  if (jsonEvent.event && (jsonEvent.class === 'call' || jsonEvent.class === 'ua')) {
    if (jsonEvent.type === 'CALL_ESTABLISHED' || jsonEvent.type === 'CALL_CONNECT') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      const rawPeerUri = jsonEvent.peeruri || jsonEvent.peer_uri || jsonEvent.remote_uri || jsonEvent.contacturi;
      const peerName = jsonEvent.peerdisplayname || jsonEvent.peername;
      
      if (uri && jsonEvent.id) {
        const updates: any = {
          callStatus: 'In Call',
          callId: jsonEvent.id
        };
        
        // Check if call already exists (e.g. from CALL_INCOMING/CALL_OUTGOING event)
        const existingCall = stateManager.getCall(jsonEvent.id);
        
        // For outgoing calls baresip sometimes sends the local contact URI as peeruri —
        // keep the remoteUri we already captured from CALL_OUTGOING.
        const peerUri = existingCall?.direction === 'outgoing' && existingCall.remoteUri
          ? existingCall.remoteUri
          : rawPeerUri || existingCall?.remoteUri;
        
        if (existingCall) {
          // Merge: update existing call, preserve direction and startTime
          stateManager.updateCall(jsonEvent.id, {
            state: 'Established',
            remoteUri: peerUri || existingCall.remoteUri,
            peerName: peerName || peerUri?.split('@')[0]?.replace(/^sip:/, '') || existingCall.peerName,
            answerTime: Date.now()
          });
        } else {
          // New call (no prior CALL_INCOMING/CALL_OUTGOING event seen)
          // Detect direction from param field (baresip includes "incoming" in param for incoming calls)
          const isIncoming = jsonEvent.param?.toLowerCase().indexOf('incoming') !== -1;
          const newCallDirection = isIncoming ? 'incoming' : 'outgoing';
          stateManager.addCall({
            callId: jsonEvent.id,
            localUri: uri,
            remoteUri: peerUri || 'unknown',
            peerName: peerName || peerUri?.split('@')[0]?.replace(/^sip:/, '') || 'Unknown',
            state: 'Established',
            direction: newCallDirection,
            startTime: isIncoming ? Date.now() - 1000 : Date.now(),
            answerTime: Date.now()
          });
          recordCallStarted(uri, peerUri || '');
        }
        
        // Only set autoConnectStatus if this account has auto-connect configured
        const account = stateManager.getAccount(uri);
        if (account && account.autoConnectContact) {
          updates.autoConnectStatus = 'Connected';
        }
        
        stateManager.updateAccountStatus(uri, updates);
        
        // Mark call as needing codec info (will be fetched by connection)
        stateManager.updateCall(jsonEvent.id, {
          needsCodecInfo: true
        });
      }
    } else if (jsonEvent.type === 'CALL_RINGING' || jsonEvent.type === 'CALL_INCOMING' || jsonEvent.type === 'CALL_OUTGOING' || jsonEvent.type === 'CALL_RTPESTAB') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      const peerUri = jsonEvent.peeruri || jsonEvent.peer_uri || jsonEvent.remote_uri || jsonEvent.contacturi;
      // For outgoing calls, peerdisplayname often contains the local account's display name (FROM header),
      // not the remote party's name. Only use it for incoming calls.
      const isOutgoing = jsonEvent.type === 'CALL_OUTGOING' || jsonEvent.direction === 'outgoing';
      const peerName = isOutgoing ? null : (jsonEvent.peerdisplayname || jsonEvent.peername);

      if (uri && jsonEvent.id) {
        // Duplicate call guard: if this account already has a different active outgoing call,
        // a new CALL_OUTGOING means baresip fired its own redial while we already reconnected.
        // Add the duplicate to state briefly (so the UI can show it), then hang it up.
        // The UI will display the second row with the hangup modal until baresip confirms closure.
        if (isOutgoing && !stateManager.getCall(jsonEvent.id)) {
          const existingActiveCalls = stateManager.getCallsByAccount(uri)
            .filter(c => c.state !== 'Closing' && c.state !== 'Closed' && c.callId !== jsonEvent.id);
          if (existingActiveCalls.length > 0) {
            const runtimeCfgDup = useRuntimeConfig();
            const connDup = getBaresipConnection(runtimeCfgDup.baresipHost, parseInt(runtimeCfgDup.baresipPort));
            stateManager.addLog('warn', 'autoconnect',
              `Duplicate CALL_OUTGOING for ${uri} while ${existingActiveCalls.length} call(s) already active — will hang up duplicate ${jsonEvent.id}`, uri);
            // Let the call fall through to normal tracking below so the UI sees it,
            // then schedule an immediate hangup. The CALL_CLOSED event will clean up state.
            setTimeout(() => {
              connDup.sendCommandSequence([
                { command: 'uafind', params: uri },
                { command: 'hangup' }
              ]);
            }, 200);
            // Fall through — do NOT return here
          }
        }

        const updates: any = {
          callStatus: jsonEvent.type === 'CALL_RTPESTAB' ? 'In Call' : 'Ringing',
          callId: jsonEvent.id
        };
        
        // For outgoing calls baresip sometimes sends the local contact URI as peeruri (invalid).
        // Fall back to autoConnectContact only if peerUri is missing or looks like the local account.
        const account = stateManager.getAccount(uri);
        const peerUriIsLocal = peerUri && uri && peerUri.replace(/^sip:/, '').split('@')[0] === uri.replace(/^sip:/, '').split('@')[0];
        const peerUriMissing = !peerUri || peerUri === uri || peerUriIsLocal;
        const effectivePeerUri = (isOutgoing && peerUriMissing && account?.autoConnectContact)
          ? account.autoConnectContact
          : peerUri;

        // Check if call already exists and update it
        const existingCall = stateManager.getCall(jsonEvent.id);
        
        if (existingCall) {
          // Update existing call with new data
          stateManager.updateCall(jsonEvent.id, {
            remoteUri: effectivePeerUri || existingCall.remoteUri,
            peerName: peerName || effectivePeerUri?.split('@')[0]?.replace(/^sip:/, '') || existingCall.peerName,
            state: jsonEvent.type === 'CALL_RTPESTAB' ? 'Established' : 'Ringing'
          });
        } else {
          // Create new call
          const callDirection = jsonEvent.direction || (jsonEvent.type === 'CALL_INCOMING' ? 'incoming' : 'outgoing');
          stateManager.addCall({
            callId: jsonEvent.id,
            localUri: uri,
            remoteUri: effectivePeerUri || 'unknown',
            peerName: peerName || effectivePeerUri?.split('@')[0]?.replace(/^sip:/, '') || 'Unknown',
            state: jsonEvent.type === 'CALL_RTPESTAB' ? 'Established' : 'Ringing',
            direction: callDirection,
            startTime: Date.now()
          });
          recordCallStarted(uri, effectivePeerUri || '');
        }
        
        // Check if this is an auto-connect call
        if (account && account.autoConnectContact) {
          updates.autoConnectStatus = jsonEvent.type === 'CALL_RTPESTAB' ? 'Connected' : 'Connecting';
        }
        
        stateManager.updateAccountStatus(uri, updates);
        
        // Mark call as needing codec info when RTP is established
        if (jsonEvent.type === 'CALL_RTPESTAB') {
          stateManager.updateCall(jsonEvent.id, {
            needsCodecInfo: true
          });
          
          // Retransmit all active outgoing GPIO states as DTMF when call connects
          const gpioState = stateManager.getGpioState(uri);
          const runtimeCfg = useRuntimeConfig();
          const connection = getBaresipConnection(runtimeCfg.baresipHost, parseInt(runtimeCfg.baresipPort));
          const activeDigits: string[] = [];
          for (let i = 0; i < 6; i++) {
            if (gpioState.gpioOut[i]) {
              activeDigits.push(gpioToDtmf(i + 1, true));
            }
          }
          if (activeDigits.length > 0) {
            // Select the exact event call under the correlated command lock.
            // Account selection is ambiguous when an account has parallel calls.
            const commands: Array<{command: string, params?: string}> = [
              { command: 'callfind', params: jsonEvent.id }
            ];
            for (const digit of activeDigits) {
              commands.push({ command: digit });
            }
            void connection.executeCommandSequence(commands).then(() => {
              stateManager.addLog('info', 'parser', `Retransmitted ${activeDigits.length} active GPIO states as DTMF on call connect`, uri);
            }).catch((error) => {
              stateManager.addLog(
                'error',
                'parser',
                `Failed to retransmit active GPIO states on call ${jsonEvent.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                uri,
              );
            });
          }
        }
      }
    } else if (jsonEvent.type === 'CALL_DTMF_START' || jsonEvent.type === 'CALL_DTMF') {
      // Incoming DTMF digit received from remote peer
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      const digit = jsonEvent.param;
      
      if (uri && digit) {
        const mapping = dtmfToGpio(digit);
        if (mapping) {
          stateManager.updateGpioIn(uri, mapping.gpioIndex, mapping.state);
          stateManager.addLog('info', 'parser', `Received DTMF '${digit}' → GPIO ${mapping.gpioIndex} ${mapping.state ? 'ON' : 'OFF'}`, uri);
        } else {
          stateManager.addLog('warn', 'parser', `Received unknown DTMF digit '${digit}'`, uri);
        }
      }
    } else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      
      if (uri) {
        // Clear incoming GPIO states when call ends
        stateManager.clearGpioIn(uri);
        
        // Check if this was an auto-connect call
        const account = stateManager.getAccount(uri);
        const wasAutoConnectCall = account && account.autoConnectContact;
        const autoConnectContact = account?.autoConnectContact;
        
        // Remove call from tracking
        if (jsonEvent.id) {
          const call = stateManager.getCall(jsonEvent.id);
          if (call && call.state !== 'Closing') {
            const durationMs = Date.now() - call.startTime;
            stateManager.updateCall(jsonEvent.id, {
              state: 'Closing',
              endTime: Date.now(),
              duration: durationMs
            });
            recordCallEnded(call.localUri, durationMs, call.remoteUri);

            // Remove after short delay to allow UI to show final state
            setTimeout(() => {
              stateManager.removeCall(jsonEvent.id);
            }, 1000);
          }
        }
        
        // Use call end reason from param (e.g. "404 Not Found", "486 Busy Here")
        // Extract only the text part, remove SIP code
        let callStatus = jsonEvent.param || 'Ended';
        
        // Remove SIP status code (e.g. "404 " from "404 Not Found")
        callStatus = callStatus.replace(/^\d{3}\s+/, '');
        // If nothing left after removing code, use original or "Ended"
        if (!callStatus.trim()) {
          callStatus = jsonEvent.param || 'Ended';
        }
        
        stateManager.updateAccountStatus(uri, { 
          callStatus: callStatus,
          autoConnectStatus: 'Off',
          callId: undefined
        });
        
        // Update contact presence based on call end reason for auto-connect calls
        let skipReconnect = false;
        
        if (wasAutoConnectCall && autoConnectContact) {
          const reason = (jsonEvent.param || '').toLowerCase();
          
          // Reasons that indicate the contact is definitely offline
          const offlineReasons = [
            'rtp stream error',      // RTP timeout - contact disconnected
            'connection timed out',  // Network timeout
            '408 request timeout',   // SIP timeout
            'request timeout',       // SIP timeout (without code)
            '503 service unavailable', // Service down
            'service unavailable',   // Service down (without code)
            '480 temporarily unavailable', // Temporarily not available
            'temporarily unavailable' // Temporarily not available (without code)
          ];
          
          // Reasons that indicate registration problems with our account
          const registrationReasons = [
            'not registered',
            '403 forbidden',
            'forbidden',
            '401 unauthorized',
            'unauthorized'
          ];
          
          // Check if call ended due to offline-indicating reason
          const isOfflineReason = offlineReasons.some(r => reason.includes(r));
          const isRegistrationError = registrationReasons.some(r => reason.includes(r));
          
          if (isOfflineReason || isRegistrationError) {
            // Set timestamp to prevent presence_ts from overwriting with old status
            stateManager.setContactCallFailureTimestamp(autoConnectContact, 'offline');
            skipReconnect = true; // Don't reconnect immediately
            
            // Broadcast contact update
            stateManager.broadcast({
              type: 'contactsUpdate',
              contacts: stateManager.getContacts()
            });
          }
        }
        
        // Reset to "Idle" after 30 seconds
        setTimeout(() => {
          const account = stateManager.getAccount(uri);
          // Only reset if still showing this status and no new call
          if (account && account.callStatus === callStatus && !account.callId) {
            stateManager.updateAccountStatus(uri, { callStatus: 'Idle' });
          }
        }, 30000);
        
        // Reconnect if auto-connect is configured (unless skipReconnect is set)
        if (!skipReconnect) {
          checkAutoConnectForAccount(uri, stateManager);
        }
      }
    }
  }
}

/**
 * Creates a LogEntry object from a text line
 */
function createLogEntryFromLine(line: string, timestamp: number): any {
  let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
  let source = 'baresip';
  let message = line;
  let accountUri: string | undefined;

  // Pattern: "module: message"
  const moduleMatch = line.match(/^([a-z_]+):\s+(.+)$/i);
  if (moduleMatch) {
    source = moduleMatch[1];
    message = moduleMatch[2];
  }

  // Pattern: "DEBUG: message" or "INFO: message"
  const levelMatch = line.match(/^(DEBUG|INFO|WARN|ERROR|WARNING):\s+(.+)$/i);
  if (levelMatch) {
    const levelStr = levelMatch[1].toLowerCase();
    level = levelStr === 'warning' ? 'warn' : levelStr as 'debug' | 'info' | 'warn' | 'error';
    message = levelMatch[2];
  }

  // Pattern: "<account@domain> message"
  const accountMatch = message.match(/<([^>]+@[^>]+)>/);
  if (accountMatch) {
    accountUri = accountMatch[1];
  }

  // Detect error patterns
  if (message.toLowerCase().includes('error') || 
      message.toLowerCase().includes('failed') ||
      message.toLowerCase().includes('cannot')) {
    level = 'error';
  } else if (message.toLowerCase().includes('warning') || 
             message.toLowerCase().includes('warn')) {
    level = 'warn';
  } else if (message.toLowerCase().includes('debug')) {
    level = 'debug';
  }

  return {
    timestamp,
    level,
    source,
    message: message.trim(),
    accountUri
  };
}

function handleTextLine(line: string, stateManager: StateManager): void {
  const timestamp = Date.now();

  // Remove ANSI escape codes (color codes, cursor positioning, etc.)
  line = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[\d+G/g, '');

  // Skip empty lines after cleanup
  if (!line.trim() || line.trim().length < 3) {
    return;
  }

  // Skip JSON event messages (they are handled by handleJsonEvent)
  if (line.trim().startsWith('{') && line.trim().includes('"event":true')) {
    return;
  }

  // Filter out audio bitrate statistics - various formats
  if (line.match(/\[\d+:\d+:\d+\]\s+audio=/i) || 
      line.match(/audio=\d+\/\d+\s*\(bit\/s\)/i)) {
    return; // Silently ignore audio statistics
  }

  // RTCP stats are handled via getrtcpstats command responses (not text lines).
  // Skip rtcp-related text lines to avoid false-positive parsing.
  if (line.includes('RTCP_STATS:') || line.includes('rtcpstats_cmd:')) {
    return;
  }

  // Create a log entry from text line (stored via addLog, sent only to log subscribers)
  const logEntry = createLogEntryFromLine(line, timestamp);
  stateManager.addLog(logEntry.level || 'info', logEntry.source || 'baresip', logEntry.message, logEntry.accountUri);

  const isAlsaSource = logEntry.source.toLowerCase() === 'alsa';
  const messageHasAlsa = logEntry.message.toLowerCase().includes('alsa');
  const isAlsaError = logEntry.level === 'error' || logEntry.message.includes('could not open');
  if ((isAlsaSource || messageHasAlsa) && isAlsaError) {
    recordAlsaError(logEntry.message);
  }

  if (logEntry.source === 'jbuf' && logEntry.message.includes('drop') && logEntry.message.includes('old frame')) {
    recordJbufDrop();
  }

  // Text-based presence parsing (from baresip modules that don't use JSON events)
  // PRESENCE_EVENT is handled above; these catch other text-format presence lines
  if (line.includes('presence:') && line.includes('open')) {
    const match = line.match(/(sip:[^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1].toLowerCase().trim();
      stateManager.setContactPresence(contact, 'online', true);
      stateManager.broadcast({ type: 'presence', timestamp, contact, status: 'online' });
      checkAutoConnectForContact(contact, stateManager);
    }
  } else if (line.includes('presence:') && (line.includes('closed') || line.includes('offline'))) {
    const match = line.match(/(sip:[^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1].toLowerCase().trim();
      stateManager.setContactPresence(contact, 'offline', true);
      stateManager.broadcast({ type: 'presence', timestamp, contact, status: 'offline' });
    }
  }
  // All other state changes (registration, calls) arrive via JSON events
  // and are handled in handleJsonEvent — no text-based fallback needed
}

function attemptAutoConnect(contact: string, stateManager: StateManager): void {
  // Find all accounts that have this contact configured for auto-connect
  const accounts = stateManager.getAccounts();

  for (const account of accounts) {
    // Check if account has active call or is ringing
    const hasActiveCall = account.callId || account.callStatus === 'In Call' || account.callStatus === 'Ringing';

    if (account.autoConnectContact === contact && account.registered && !hasActiveCall) {
      // Check if contact is online (not busy - we want only one call per contact)
      const contactPresence = stateManager.getContactPresence(contact);
      if (contactPresence !== 'online') continue;

      // Guard 1: cooldown – don't dial the same account twice within DIAL_COOLDOWN_MS
      const lastDial = lastDialTime.get(account.uri) || 0;
      if (Date.now() - lastDial < DIAL_COOLDOWN_MS) {
        stateManager.addLog('debug', 'autoconnect', `Skipping dial for ${account.uri} – cooldown active`, account.uri);
        break;
      }

      // Guard 2: deduplication – skip if this account is already waiting in the queue
      if (queuedAccountUris.has(account.uri)) {
        stateManager.addLog('debug', 'autoconnect', `Skipping dial for ${account.uri} – already queued`, account.uri);
        break;
      }

      queuedAccountUris.add(account.uri);

      // Add to queue to prevent race conditions with uafind
      autoConnectQueue.push(() => {
        // Remove from queued set so future attempts can proceed
        queuedAccountUris.delete(account.uri);

        // Guard 3: re-check state at execution time (might have changed while queued)
        const currentAccount = stateManager.getAccount(account.uri);
        // Also check the calls array – callId may not be set yet if CALL_OUTGOING hasn't arrived
        const activeCalls = stateManager.getCallsByAccount(account.uri);
        const hasActiveCallNow = activeCalls.some(c => c.state !== 'Closing' && c.state !== 'Closed');
        const currentlyBusy = !currentAccount ||
          currentAccount.callId ||
          currentAccount.callStatus === 'In Call' ||
          currentAccount.callStatus === 'Ringing' ||
          hasActiveCallNow;

        if (currentlyBusy) {
          stateManager.addLog('debug', 'autoconnect', `Skipping dial for ${account.uri} – busy at execution time`, account.uri);
          return;
        }

        lastDialTime.set(account.uri, Date.now());

        const runtimeConfig = useRuntimeConfig();
        const connection = getBaresipConnection(runtimeConfig.baresipHost, parseInt(runtimeConfig.baresipPort));

        // Use serialized command sequence to prevent uafind race conditions
        // (e.g. codec info fetch could interleave and change active UA)
        connection.sendCommandSequence([
          { command: 'uafind', params: account.uri },
          { command: 'dial', params: contact }
        ]);

        // All status updates happen through baresip events:
        // CALL_OUTGOING -> callStatus: 'Ringing', autoConnectStatus: 'Connecting'
        // CALL_ESTABLISHED -> callStatus: 'In Call', autoConnectStatus: 'Connected'
        // CALL_CLOSED -> callStatus: 'Idle', autoConnectStatus: 'Off' -> triggers reconnect
      });

      // Start processing queue
      processAutoConnectQueue();

      // Only queue one account per contact at a time
      break;
    }
  }
}

// Check auto-connect when account becomes registered
function checkAutoConnectForAccount(accountUri: string, stateManager: StateManager): void {
  const account = stateManager.getAccount(accountUri);
  
  if (!account || !account.autoConnectContact || !account.registered) {
    return;
  }
  
  // Check if account has an active call (callId is set) or is ringing
  // Don't check callStatus === 'Idle' because it shows end reason for 30s after call
  if (account.callId || account.callStatus === 'In Call' || account.callStatus === 'Ringing') {
    return;
  }

  // Check if the contact is online (not busy - we want only one call per contact)
  const contactPresence = stateManager.getContactPresence(account.autoConnectContact);
  
  if (contactPresence === 'online') {
    attemptAutoConnect(account.autoConnectContact, stateManager);
  }
}

/**
 * Check auto-connect for all accounts that have the specified contact configured
 * @param contact The contact URI to check
 * @param stateManager The state manager instance
 */
function checkAutoConnectForContact(contact: string, stateManager: StateManager): void {
  const accounts = stateManager.getAccounts();
  // Normalize contact URI (remove sip: prefix for comparison)
  const normalizedContact = contact.replace('sip:', '').toLowerCase().trim();
  
  for (const account of accounts) {
    if (account.autoConnectContact) {
      const normalizedAccountContact = account.autoConnectContact.replace('sip:', '').toLowerCase().trim();
      if (normalizedAccountContact === normalizedContact) {
        checkAutoConnectForAccount(account.uri, stateManager);
      }
    }
  }
}

// Export helper functions for use in other modules
export { checkAutoConnectForAccount, checkAutoConnectForContact };
