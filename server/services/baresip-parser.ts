import { parseNetstring } from '../utils/netstring';
import type { StateManager } from './state-manager';
import type { BaresipEvent, BaresipCommandResponse } from '~/types';
import { getBaresipConnection } from './baresip-connection';

// Global queue to serialize auto-connect operations
let autoConnectQueue: Array<() => void> = [];
let isProcessingAutoConnect = false;

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

export function parseBaresipEvent(data: Buffer, stateManager: StateManager, rtcpBuffer?: { buffer: string }): void {
  const dataStr = data.toString();

  try {
    const netstringMessages = parseNetstring(data);
    if (netstringMessages.length > 0) {
      for (const messageStr of netstringMessages) {
        try {
          const jsonMessage = JSON.parse(messageStr);

          if (jsonMessage.response !== undefined) {
            handleCommandResponse(jsonMessage, stateManager);
          } else if (jsonMessage.event) {
            handleJsonEvent(jsonMessage, stateManager);
          }
        } catch (e) {
          handleTextLine(messageStr, stateManager);
        }
      }
      return;
    }
  } catch (e) {
    // Fallback to text parsing
  }

  const lines = dataStr.split('\n').filter(line => line.trim());
  for (const line of lines) {
    handleTextLine(line, stateManager);
  }
}

function handleCommandResponse(response: BaresipCommandResponse, stateManager: StateManager): void {
  const timestamp = Date.now();

  //  Dispatch-Logic for different response types
  if (typeof response.data === 'string') {
    const data = response.data;
    
    // Check if this is getrtcpstats JSON response
    if (data.includes('call_id') && data.startsWith('[')) {
      try {
        parseGetRtcpStatsResponse(data, stateManager);
        return;
      } catch (e) {
        // Silently ignore parse errors
      }
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
  
  // Fallback: Log unhandled command response
  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: `Unhandled Command Response: ${JSON.stringify(response)}`
  });
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
    
    if (typeof stateManager.setBaresipInfo === 'function') {
      stateManager.setBaresipInfo({ version, uptime, started });
    }
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
  const PRESENCE_TIMEOUT_SEC = 600; // 10 minutes - mark as unknown if no update
  let updatedCount = 0;

  for (const line of lines) {
    // Match format: sip:uri|status|timestamp
    const match = line.match(/(sip:[^@]+@[^|]+)\|(\w+)\|(\d+)/);
    if (!match) continue;

    const contact = match[1];
    const status = match[2].toLowerCase();
    const timestamp = parseInt(match[3], 10);
    
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
    updatedCount++;
    
    // Trigger auto-connect if contact just came online
    if (effectiveStatus === 'online' && previousPresence !== 'online') {
      checkAutoConnectForContact(contact, stateManager);
    }
  }
  
  // Broadcast changes if any contacts were updated
  if (updatedCount > 0) {
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
      if (!call.audioRxStats) {
        call.audioRxStats = {
          packets: 0, lost: 0, bitrate_kbps: 0, dropout: false,
          dropout_total: 0, rtp_rx_errors: 0, jitter: 0
        };
      }
      call.audioRxStats.packets = stats.rtp_rx_packets ?? 0;
      call.audioRxStats.lost = stats.rtcp_lost_rx ?? 0;
      call.audioRxStats.bitrate_kbps = stats.rx_bitrate_kbps ?? 0;
      call.audioRxStats.dropout = stats.rx_dropout ?? false;
      call.audioRxStats.dropout_total = stats.rx_dropout_total ?? 0;
      call.audioRxStats.jitter = stats.rtcp_jitter_rx_ms ?? 0;
      
      // Update TX stats
      if (!call.audioTxStats) {
        call.audioTxStats = { packets: 0, lost: 0, bitrate_kbps: 0, jitter: 0 };
      }
      call.audioTxStats.packets = stats.rtp_tx_packets ?? 0;
      call.audioTxStats.lost = stats.rtcp_lost_tx ?? 0;
      call.audioTxStats.bitrate_kbps = stats.tx_bitrate_kbps ?? 0;
      call.audioTxStats.jitter = stats.rtcp_jitter_tx_ms ?? 0;

      stateManager.broadcast({ type: 'callUpdated', data: call });
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
  // User-Agent: 2061616@sip.srgssr.ch
  // --- Active calls (1) ---
  // > [line 1, id 8fd950528ad2127d]  1:23:38  ESTABLISHED            
  //
  // Strategy: Last wins for updates - new info overwrites old
  // - listcalls response ADDS/UPDATES calls found (e.g., on UI reconnect)
  // - BUT does NOT remove calls (unless autoReset=true)
  // - Events (CALL_CLOSED) handle call removal in real-time
  
  const activeCallIds: Set<string> = new Set();
  let foundAnyCall = false;
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
    
    // Parse call line: > [line 1, id 8fd950528ad2127d]  1:23:38  ESTABLISHED       
    const callMatch = line.match(/>\s*\[line\s+\d+,\s*id\s+([a-f0-9]+)\]\s+[\d:]+\s+(\w+)\s+(sip:[^@\s]+@[^\s]+)/i);
    if (callMatch) {
      foundAnyCall = true;
      
      const callId = callMatch[1];
      const callState = callMatch[2].trim().toUpperCase();
      const remoteUri = callMatch[3];
      const localUri = currentUserAgent;
      
      if (!localUri) {
        continue;
      }
      
      activeCallIds.add(callId);
      
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
        direction: callDirection,
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
    const accountsWithCalls = new Set<string>();
    
    // Track which accounts have calls in this response
    if (currentUserAgent && foundAnyCall) {
      accountsWithCalls.add(currentUserAgent.toLowerCase().trim());
    }
    
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

function handleJsonEvent(jsonEvent: BaresipEvent, stateManager: StateManager): void {
  const timestamp = Date.now();

  // Add log entry (skip VU_TX_REPORT and VU_RX_REPORT to avoid clutter)
  if (jsonEvent.type !== 'VU_TX_REPORT' && jsonEvent.type !== 'VU_RX_REPORT') {
    stateManager.addLog('event', `${jsonEvent.class}:${jsonEvent.type}`, jsonEvent);
  }

  if (jsonEvent.event && jsonEvent.class === 'ua') {
    if (jsonEvent.type === 'REGISTER_OK') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        const account = stateManager.getAccount(uri);
        stateManager.updateAccountStatus(uri, {
          registered: true,
          registrationError: undefined
        });
        
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
      const peerUri = jsonEvent.peeruri || jsonEvent.peer_uri || jsonEvent.remote_uri || jsonEvent.contacturi;
      const peerName = jsonEvent.peerdisplayname || jsonEvent.peername;
      
      if (uri && jsonEvent.id) {
        const updates: any = {
          callStatus: 'In Call',
          callId: jsonEvent.id
        };
        
        // Add call to active calls tracking
        stateManager.addCall({
          callId: jsonEvent.id,
          localUri: uri,
          remoteUri: peerUri || 'unknown',
          peerName: peerName || peerUri?.split('@')[0] || 'Unknown',
          state: 'Established',
          direction: jsonEvent.direction || 'unknown',
          startTime: jsonEvent.param?.includes('incoming') ? Date.now() - 1000 : Date.now(),
          answerTime: Date.now(),
          audioRxStats: {
            packets: 0,
            packetsLost: 0,
            jitter: 0,
            bitrate: 64000
          },
          audioTxStats: {
            packets: 0,
            packetsLost: 0,
            bitrate: 64000
          }
        });
        
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
      const peerName = jsonEvent.peerdisplayname || jsonEvent.peername;
      
      if (uri && jsonEvent.id) {
        const updates: any = { 
          callStatus: jsonEvent.type === 'CALL_RTPESTAB' ? 'In Call' : 'Ringing',
          callId: jsonEvent.id
        };
        
        // Check if call already exists and update it
        const existingCall = stateManager.getCall(jsonEvent.id);
        
        if (existingCall) {
          // Update existing call with new data
          stateManager.updateCall(jsonEvent.id, {
            remoteUri: peerUri || existingCall.remoteUri,
            peerName: peerName || peerUri?.split('@')[0] || existingCall.peerName,
            state: jsonEvent.type === 'CALL_RTPESTAB' ? 'Established' : 'Ringing'
          });
        } else {
          // Create new call
          stateManager.addCall({
            callId: jsonEvent.id,
            localUri: uri,
            remoteUri: peerUri || 'unknown',
            peerName: peerName || peerUri?.split('@')[0] || 'Unknown',
            state: jsonEvent.type === 'CALL_RTPESTAB' ? 'Established' : 'Ringing',
            direction: jsonEvent.direction || (jsonEvent.type === 'CALL_INCOMING' ? 'incoming' : 'outgoing'),
            startTime: Date.now()
          });
        }
        
        // Check if this is an auto-connect call
        const account = stateManager.getAccount(uri);
        if (account && account.autoConnectContact) {
          updates.autoConnectStatus = jsonEvent.type === 'CALL_RTPESTAB' ? 'Connected' : 'Connecting';
        }
        
        stateManager.updateAccountStatus(uri, updates);
        
        // Mark call as needing codec info when RTP is established
        if (jsonEvent.type === 'CALL_RTPESTAB') {
          stateManager.updateCall(jsonEvent.id, {
            needsCodecInfo: true
          });
        }
      }
    } else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      
      if (uri) {
        // Check if this was an auto-connect call
        const account = stateManager.getAccount(uri);
        const wasAutoConnectCall = account && account.autoConnectContact;
        const autoConnectContact = account?.autoConnectContact;
        
        // Remove call from tracking
        if (jsonEvent.id) {
          const call = stateManager.getCall(jsonEvent.id);
          if (call) {
            stateManager.updateCall(jsonEvent.id, {
              state: 'Closing',
              endTime: Date.now(),
              duration: Date.now() - call.startTime
            });
            
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

function parseRtcpSummaryLine(line: string, stateManager: StateManager): void {
  // Parse RTCP stats from rtcpstats_periodic module
  // NEW JSON Format: RTCP_STATS: {...full JSON...}
  // SHORT Format: rtcpstats_periodic: call_id=xxx rx_packets=123 tx_packets=456 rx_bitrate_kbps=0 tx_bitrate_kbps=1 rx_dropout=false rx_dropout_total=0
  // OLD Format: "RTCP_STATS: call_id=xxx;media=audio;packets_rx=123;..."
  
  if (!line.includes('RTCP') && !line.includes('rtcpstats')) return;
  
  // Try JSON format first
  if (line.includes('RTCP_STATS:')) {
    const jsonMatch = line.match(/RTCP_STATS:\s*(\{.+\})/);
    if (jsonMatch) {
      try {
        const stats = JSON.parse(jsonMatch[1]);
        const callId = stats.call_id;
        if (!callId) return;
        
        const updates: any = {};
        updates.audioRxStats = {
          packets: stats.rtp_rx_packets ?? 0,
          packetsLost: stats.rtcp_lost_rx ?? 0,
          jitter: stats.rtcp_jitter_rx_ms ?? 0,
          rtt: stats.rtcp_rtt_ms ?? 0,
          bitrate_kbps: stats.rx_bitrate_kbps ?? 0,
          dropout: stats.rx_dropout ?? false,
          dropout_total: stats.rx_dropout_total ?? 0,
          rtp_rx_errors: stats.rtp_rx_errors ?? 0,
          rtcp_packets: stats.rtcp_rx_packets ?? 0,
        };
        updates.audioTxStats = {
          packets: stats.rtp_tx_packets ?? 0,
          packetsLost: stats.rtcp_lost_tx ?? 0,
          jitter: stats.rtcp_jitter_tx_ms ?? 0,
          bitrate_kbps: stats.tx_bitrate_kbps ?? 0,
          rtp_tx_errors: stats.rtp_tx_errors ?? 0,
          rtcp_packets: stats.rtcp_tx_packets ?? 0,
        };
        
        stateManager.updateCall(callId, updates);
        return;
      } catch (e) {
        // Failed to parse JSON format, try short format
      }
    }
  }
  
  // Try short format: rtcpstats_periodic: call_id=xxx rx_packets=123 tx_packets=456...
  if (line.includes('rtcpstats_periodic:')) {
    const callIdMatch = line.match(/call_id=([a-f0-9]+)/);
    const rxPacketsMatch = line.match(/rx_packets=(\d+)/);
    const txPacketsMatch = line.match(/tx_packets=(\d+)/);
    const rxBitrateMatch = line.match(/rx_bitrate_kbps=(\d+)/);
    const txBitrateMatch = line.match(/tx_bitrate_kbps=(\d+)/);
    const rxDropoutMatch = line.match(/rx_dropout=(true|false)/);
    const rxDropoutTotalMatch = line.match(/rx_dropout_total=(\d+)/);
    
    if (callIdMatch) {
      const callId = callIdMatch[1];
      const updates: any = {};
      
      updates.audioRxStats = {
        packets: rxPacketsMatch ? parseInt(rxPacketsMatch[1]) : 0,
        packetsLost: 0,
        jitter: 0,
        bitrate_kbps: rxBitrateMatch ? parseInt(rxBitrateMatch[1]) : 0,
        dropout: rxDropoutMatch ? rxDropoutMatch[1] === 'true' : false,
        dropout_total: rxDropoutTotalMatch ? parseInt(rxDropoutTotalMatch[1]) : 0,
      };
      
      updates.audioTxStats = {
        packets: txPacketsMatch ? parseInt(txPacketsMatch[1]) : 0,
        packetsLost: 0,
        jitter: 0,
        bitrate_kbps: txBitrateMatch ? parseInt(txBitrateMatch[1]) : 0,
      };
      
      stateManager.updateCall(callId, updates);
      return;
    }
  }
  
  // Fallback to OLD semicolon-delimited format (for compatibility)
  
  const callIdMatch = line.match(/call_id=([^;]+)/);
  const packetsRxMatch = line.match(/packets_rx=(\d+)/);
  const packetsTxMatch = line.match(/packets_tx=(\d+)/);
  
  if (callIdMatch && packetsRxMatch) {
    const callId = callIdMatch[1];
    const updates: any = {};
    
    updates.audioRxStats = {
      packets: parseInt(packetsRxMatch[1]),
      packetsLost: 0,
      jitter: 0,
      bitrate: 0
    };
    
    if (packetsTxMatch) {
      updates.audioTxStats = {
        packets: parseInt(packetsTxMatch[1]),
        packetsLost: 0,
        bitrate: 0
      };
    }
    
    // Update the call with statistics
    stateManager.updateCall(callId, updates);
  }
}

function parseCallStatLine(line: string, stateManager: StateManager): void {
  // Parse RTP statistics from Baresip callstat output
  const callIdMatch = line.match(/Call\s+([a-zA-Z0-9-]+):/);
  const isRx = line.toLowerCase().includes('rx:') || line.toLowerCase().includes('receive');
  const isTx = line.toLowerCase().includes('tx:') || line.toLowerCase().includes('transmit');
  
  if (!isRx && !isTx) return;
  
  const packetsMatch = line.match(/packets[=:\s]+(\d+)/i);
  const lostMatch = line.match(/lost[=:\s]+(\d+)/i);
  const jitterMatch = line.match(/jitter[=:\s]+([\d.]+)/i);
  const bitrateMatch = line.match(/bitrate[=:\s]+(\d+)/i);
  
  if (packetsMatch) {
    const stats = {
      packets: parseInt(packetsMatch[1]),
      packetsLost: lostMatch ? parseInt(lostMatch[1]) : 0,
      jitter: jitterMatch ? parseFloat(jitterMatch[1]) : undefined,
      bitrate: bitrateMatch ? parseInt(bitrateMatch[1]) : 0
    };
    
    // If we have a call ID, update that specific call
    if (callIdMatch) {
      const callId = callIdMatch[1];
      const updates: any = {};
      
      if (isRx) {
        updates.audioRxStats = stats;
      } else {
        updates.audioTxStats = { ...stats };
        delete updates.audioTxStats.jitter; // TX doesn't have jitter
      }
      
      stateManager.updateCall(callId, updates);
    } else {
      // Try to find active call and update it
      const calls = stateManager.getCalls();
      if (calls.length === 1) {
        // Only one active call, update it
        const updates: any = {};
        
        if (isRx) {
          updates.audioRxStats = stats;
        } else {
          updates.audioTxStats = { ...stats };
          delete updates.audioTxStats.jitter;
        }
        
        stateManager.updateCall(calls[0].callId, updates);
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

  // Parse RTCP/RTP statistics (from rtcpsummary or rtcpstats_periodic modules)
  if (line.includes('RTCP') || line.includes('rtcp') || line.includes('rtcpstats')) {
    parseRtcpSummaryLine(line, stateManager);
    return; // Important: return after parsing RTCP to avoid duplicate processing
  }

  // Parse getrtcpstats JSON response (JSON array or objects with call_id field)
  if (line.includes('call_id') && (line.includes('[') || line.includes('{') || line.includes('rtp_rx_packets'))) {
    parseGetRtcpStatsResponse(line, stateManager);
    return;
  }

  // Parse call statistics output from /callstat command
  // Example formats:
  // "audio RX: packets=1234 lost=5 jitter=12.5ms bitrate=64000"
  // "       rx: 1234 packets, 5 lost, jitter=12.5ms"
  // "Stream #0 audio RX: pt=8, packets=1234, lost=5, jitter=12.5ms"
  if (line.match(/audio\s+(RX|TX):|\s+(rx|tx):|Stream.*audio/i)) {
    parseCallStatLine(line, stateManager);
    return; // Don't broadcast as log
  }

  // Handle PRESENCE_EVENT messages from enhanced_presence module
  if (line.indexOf('PRESENCE_EVENT:') !== -1) {
    const parts = line.split(':');
    if (parts.length >= 3) {
      const contact = parts[1].replace('sip:', '').trim();
      const status = parts[2].toLowerCase().trim();
      
      let mappedStatus = 'unknown';
      if (status === 'online' || status === 'open') {
        mappedStatus = 'online';
      } else if (status === 'offline' || status === 'closed') {
        mappedStatus = 'offline';
      } else if (status === 'busy') {
        mappedStatus = 'busy';
      } else if (status === 'away') {
        mappedStatus = 'away';
      }
      
      stateManager.setContactPresence(contact, mappedStatus, true);

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: mappedStatus
      });

      // Trigger auto-connect check for all accounts configured for this contact
      // when contact status changes to online
      if (mappedStatus === 'online') {
        checkAutoConnectForContact(contact, stateManager);
      }
    }
  }

  // Create a proper LogEntry object and broadcast it
  const logEntry = createLogEntryFromLine(line, timestamp);
  
  stateManager.broadcast({
    type: 'log',
    data: logEntry
  });

  if (line.includes('registered successfully')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, {
        registered: true,
        registrationError: undefined
      });
      // Trigger auto-connect check when account registers
      checkAutoConnectForAccount(uri, stateManager);
    }
  } else if (line.includes('unregistering')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { registered: false });
    }
  } else if (line.includes('reg:') && (line.includes('401 Unauthorized') || line.includes('403 Forbidden') || line.includes('404 Not Found') || line.includes('408 Request Timeout') || line.includes('503 Service Unavailable'))) {
    const match = line.match(/reg:\s*(sip:[^@]+@[^)]+)/);
    if (match) {
      const uri = match[1];
      let errorStatus = 'Registration Error';
      if (line.includes('401 Unauthorized')) errorStatus = 'Unauthorized';
      else if (line.includes('403 Forbidden')) errorStatus = 'Forbidden';
      else if (line.includes('404 Not Found')) errorStatus = 'Not Found';
      else if (line.includes('408 Request Timeout')) errorStatus = 'Timeout';
      else if (line.includes('503 Service Unavailable')) errorStatus = 'Service Unavailable';

      stateManager.updateAccountStatus(uri, {
        registered: false,
        registrationError: errorStatus,
        lastRegistrationAttempt: timestamp
      });
    }
  } else if (line.includes('reg:') && line.includes('sip:')) {
    const match = line.match(/reg:\s*(sip:[^@\s]+@[^\s);]+)/);
    if (match) {
      const uri = match[1];
      if (!stateManager.hasAccount(uri)) {
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
  } else if (line.includes('Call established')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'In Call' });
    }
  } else if (line.includes('Call ringing')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'Ringing' });
    }
  } else if (line.includes('Call terminated') || line.includes('session closed')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'Idle' });
      // Trigger auto-connect check when call terminates
      checkAutoConnectForAccount(uri, stateManager);
    }
  } else if (line.includes('presence:') && line.includes('open')) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1].toLowerCase().trim();
      stateManager.setContactPresence(contact, 'online', true);

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: 'online'
      });

      // Trigger auto-connect check for all accounts configured for this contact
      checkAutoConnectForContact(contact, stateManager);

      const config = stateManager.getContactConfig(contact);
      if (config?.enabled) {
        attemptAutoConnect(contact, stateManager);
      }
    }
  } else if (line.includes('presence:') && (line.includes('closed') || line.includes('offline'))) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1].toLowerCase().trim();
      stateManager.setContactPresence(contact, 'offline', true);

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: 'offline'
      });
    }
  } else if (line.indexOf('PRESENCE_EVENT:') !== -1) {
    // Handle enhanced presence JSON events
    // Format: PRESENCE_EVENT: {"contact":"sip:2061531@sip.srgssr.ch","status":"online"}
    const jsonStart = line.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const jsonStr = line.substring(jsonStart);
        const presenceEvent = JSON.parse(jsonStr);
        
        if (presenceEvent.contact && presenceEvent.status) {
          // Extract contact without sip: prefix
          const contact = presenceEvent.contact.replace('sip:', '').toLowerCase().trim();
          const status = presenceEvent.status.toLowerCase().trim();
          
          stateManager.setContactPresence(contact, status, true);

          stateManager.broadcast({
            type: 'presence',
            timestamp,
            contact,
            status
          });

          // Trigger auto-connect check for all accounts configured for this contact
          // when contact status changes to online
          if (status === 'online') {
            checkAutoConnectForContact(contact, stateManager);
          }
        }
      } catch (e) {
        console.error('Failed to parse PRESENCE_EVENT JSON:', e);
      }
    }
  } else if (line.indexOf('enhanced_presence:') !== -1 && line.indexOf('is now') !== -1) {
    // Handle legacy enhanced presence module messages (fallback)
    // Format: enhanced_presence: <"unity 1" <sip:2061531@sip.srgssr.ch>;presence=p2p> is now 'Online'
    const match = line.match(/<sip:([^@]+@[^>]+)>[^>]*is now '([^']+)'/);
    if (match) {
      const contact = match[1];
      const statusText = match[2].toLowerCase();
      
      let status = 'unknown';
      if (statusText === 'online' || statusText === 'open') {
        status = 'online';
      } else if (statusText === 'offline' || statusText === 'closed') {
        status = 'offline';
      } else if (statusText === 'busy') {
        status = 'busy';
      } else if (statusText === 'away') {
        status = 'away';
      }
      
      stateManager.setContactPresence(contact, status, true);

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status
      });

      const config = stateManager.getContactConfig(contact);
      if (config?.enabled && status === 'online') {
        attemptAutoConnect(contact, stateManager);
      }
    }
  } else if (line.includes('sip:') && line.includes('@') && !line.includes('presence:') && !line.includes('reg:')) {
      const match = line.match(/([^<]*)<\s*(sip:[^@\s]+@[^\s>;,)]+)\s*>?/);
    if (match) {
        const name = match[1] ? match[1].trim() : undefined;
        const uri = match[2];
      if (!stateManager.hasAccount(uri)) {
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
}

function attemptAutoConnect(contact: string, stateManager: StateManager): void {
  // Find all accounts that have this contact configured for auto-connect
  const accounts = stateManager.getAccounts();
  
  for (const account of accounts) {
    // Check if account has active call or is ringing (don't check callStatus === 'Idle')
    const hasActiveCall = account.callId || account.callStatus === 'In Call' || account.callStatus === 'Ringing';
    
    if (account.autoConnectContact === contact && account.registered && !hasActiveCall) {
      // Check if contact is online (not busy - we want only one call per contact)
      const contactPresence = stateManager.getContactPresence(contact);
      if (contactPresence === 'online') {
        // Add to queue to prevent race conditions with uafind
        autoConnectQueue.push(() => {
          // Double-check status before executing (might have changed while in queue)
          const currentAccount = stateManager.getAccount(account.uri);
          const currentlyBusy = currentAccount && (currentAccount.callId || currentAccount.callStatus === 'In Call' || currentAccount.callStatus === 'Ringing');
          
          if (!currentAccount || currentlyBusy) {
            return;
          }
          
          const runtimeConfig = useRuntimeConfig();
          const connection = getBaresipConnection(runtimeConfig.baresipHost, parseInt(runtimeConfig.baresipPort));
          
          // Select account and dial sequentially
          connection.sendCommand('uafind', account.uri);
          
          // Wait for account selection before dialing
          setTimeout(() => {
            connection.sendCommand('dial', contact);
          }, 150);
          
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
