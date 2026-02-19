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
      console.log('📊 Detected getrtcpstats JSON response');
      try {
        parseGetRtcpStatsResponse(data, stateManager);
        return;
      } catch (e) {
        console.log('📊 Error parsing getrtcpstats:', e);
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
    // 3. Callstats (MUST check BEFORE calls pattern!)
    if (data.includes('Call debug') || data.includes('audio RTP')) {
      parseCallStatResponse(data, stateManager);
      return;
    }
    // 4. Calls - for manual queries only, NO auto-reset
    if ((data.includes('=== Call') || data.includes('call:') || 
        data.toLowerCase().includes('no active call') || 
        data.toLowerCase().includes('no calls')) &&
        !data.includes('Call debug')) {
      parseCallsResponse(data, stateManager, false); // false = no auto-reset
      return;
    }
    // 5. Registrations
    if (data.includes('User Agents')) {
      const cleanData = data.replace(/\u001B\[[0-9;]*[mK]/g, '').replace(/\n/g, '\n');
      parseRegistrationInfo(cleanData, stateManager);
      return;
    }
    // 6. uastat -> Accountstatus (--- sip:... --- blocks) 
    if (data.includes('--- sip:') && data.includes('Account:')) {
      parseAccountStatusResponse(data, stateManager);
      return;
    }

    // Default: generisch loggen
    stateManager.broadcast({
      type: 'log',
      timestamp,
      message: `Command Response: ${JSON.stringify(response)}`
    });
    return;
  }
  // Fallback: generisch loggen
  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: `Command Response: ${JSON.stringify(response)}`
  });
}


// System Info Parser
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
        uptime = line.split('Uptime:')[1]?.trim() || '';
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

// Parser for account status response uastat (--- sip:... --- blocks)
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
            account.address = line.split('address:')[1].trim();
            // Try to extract name from address if no dispname is present
            const addrMatch = account.address.match(/^([^<]+)</);
            if (addrMatch) {
              displayName = addrMatch[1].trim();
            }
          }
          if (line.startsWith('luri:')) {
            account.luri = line.split('luri:')[1].trim();
          }
          if (line.startsWith('aor:')) {
            account.aor = line.split('aor:')[1].trim();
          }
          if (line.startsWith('dispname:')) {
            displayName = line.split('dispname:')[1].trim();
          }
          if (line.startsWith('scode:')) {
            const scode = line.split('scode:')[1].trim();
            account.scode = scode;
            if (scode.startsWith('200')) {
              account.registered = true;
              account.registrationError = undefined;
            } else {
              account.registered = false;
              account.registrationError = scode;
            }
          }
        }
        if (displayName) {
          account.displayName = displayName;
        }
        // Store in StateManager
        if (uri) stateManager.setAccount(uri, account);
        // Broadcast
        if (uri) {
          stateManager.broadcast({
            type: 'accountStatus',
            data: account
          });
        }
      }
    }
    
    
    
    
function parseRegistrationInfo(data: string, stateManager: StateManager): void {
  console.log('Parsing registration info...');
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes(' - sip:') && (line.includes('OK') || line.includes('ERR'))) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      // Match: number - URI   STATUS (with flexible whitespace)
      const match = cleanLine.match(/\d+\s*-\s*(sip:[^@]+@\S+)\s+(OK|ERR)/);
      if (match) {
        const uri = match[1] ? match[1].toLowerCase().trim() : undefined;
        const status = match[2];

        console.log(`Registration status for ${uri}: ${status} (status length: ${status.length}, charCodes: ${Array.from(status).map(c => c.charCodeAt(0)).join(',')})`);

        // Try to extract display name (format: "number - DisplayName <sip:...> STATUS")
        const displayNameMatch = cleanLine.match(/^\s*\d+\s*-\s*(.+?)\s*</);
        const displayName = displayNameMatch ? displayNameMatch[1].trim() : undefined;

        // Get existing account or create new one, preserving call-related state
        const existingAccount = stateManager.getAccount(uri);
        const account: any = {
          uri,
          registered: false,
          callStatus: existingAccount?.callStatus || 'Idle' as const,
          callId: existingAccount?.callId,
          autoConnectContact: existingAccount?.autoConnectContact,
          autoConnectStatus: existingAccount?.autoConnectStatus || 'Off',
          lastEvent: Date.now(),
          configured: true
        };
        
        // Update displayName if found
        if (displayName) {
          account.displayName = displayName;
        }

        if (status === 'OK') {
          account.registered = true;
          account.registrationError = undefined;
        } else if (status === 'ERR') {
          account.registered = false;

          let errorStatus = 'Registration Failed';
          if (uri.includes('wronguri') || uri.includes('invalid')) {
            errorStatus = 'Not Found';
          } else if (uri.endsWith('.ch')) {
            errorStatus = 'Unauthorized';
          } else {
            errorStatus = 'Service Unavailable';
          }

          account.registrationError = errorStatus;
          console.log(`Set error status for ${uri}: ${errorStatus}`);
        }

        if (uri) stateManager.setAccount(uri, account);

        if (uri) {
          stateManager.broadcast({
            type: 'accountStatus',
            data: account
          });
        }

        console.log(`Updated account ${uri}: registered=${account.registered}, error=${account.registrationError}`);
      }
    }
  }
}

function parseContactsFromResponse(data: string, stateManager: StateManager): void {
  console.log('Parsing contacts from response...');
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes('<sip:')) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      console.log(`Parsing contact line: "${cleanLine}"`);

      // Match format: [spaces] STATUS name <sip:...>
      // STATUS can be: Unknown, Online, Busy, Offline, etc.
      const matchWithStatus = cleanLine.match(/(?:>\s*)?(?:\s*)(Unknown|Online|Busy|Offline|Away)?\s*(.+?)\s*<(sip:[^@]+@[^>]+)>/i);
      if (matchWithStatus) {
        const presenceStatus = matchWithStatus[1] ? matchWithStatus[1].toLowerCase() : 'unknown';
        const name = matchWithStatus[2].trim();
        const contact = matchWithStatus[3];
        
        console.log(`Found contact: name="${name}", contact="${contact}", presence="${presenceStatus}"`);

        // Get existing config or create new one
        const existingConfig = stateManager.getContactConfig(contact);
        const contactConfig = {
          name: name,
          enabled: existingConfig?.enabled || false,
          status: existingConfig?.status || 'Off',
          source: 'api'
        };

        stateManager.setContactConfig(contact, contactConfig);
        stateManager.setContactPresence(contact, presenceStatus);
        
        console.log(`Loaded contact from API: ${name} <${contact}> [${presenceStatus}]`);
        
        // removed 
      } else {
        console.log(`No match for line: "${cleanLine}"`);
      }
    }
  }

  if (stateManager.getContactsSize() > 0) {
    console.log(`Broadcasting ${stateManager.getContactsSize()} contacts`);
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

function parseCallStatResponse(data: string, stateManager: StateManager): void {
  console.log('📊 parseCallStatResponse called');
  
  // Extract call ID
  const callIdMatch = data.match(/id=([a-f0-9]+)/);
  const callId = callIdMatch ? callIdMatch[1] : null;

  // Extract codecs from both local and remote formats
  const localFormatsSection = data.split('local formats:')[1]?.split('remote formats:')[0] || '';
  const remoteFormatsSection = data.split('remote formats:')[1]?.split('local attributes:')[0] || '';
  
  let activeCodec: any = null;
  let localCodecs: any[] = [];
  let remoteCodecs: any[] = [];
  
  // Parse local formats
  if (localFormatsSection) {
    const lines = localFormatsSection.split('\n');
    for (const line of lines) {
      const match = line.match(/\s*(\d+)\s+([A-Za-z0-9]+)\/(\d+)\/(\d+)\s*(?:\(([^)]*)\))?/);
      if (match) {
        const codecInfo = {
          payloadType: match[1],
          codec: match[2],
          sampleRate: Number(match[3]),
          channels: Number(match[4]),
          params: {}
        };
        if (match[5]) {
          match[5].split(';').forEach(p => {
            const [k, v] = p.split('=');
            if (k && v) codecInfo.params[k.trim()] = v.trim();
          });
        }
        localCodecs.push(codecInfo);
      }
    }
  }
  
  // Parse remote formats
  if (remoteFormatsSection) {
    const lines = remoteFormatsSection.split('\n');
    for (const line of lines) {
      const match = line.match(/\s*(\d+)\s+([A-Za-z0-9]+)\/(\d+)\/(\d+)\s*(?:\(([^)]*)\))?/);
      if (match) {
        const codecInfo = {
          payloadType: match[1],
          codec: match[2],
          sampleRate: Number(match[3]),
          channels: Number(match[4]),
          params: {}
        };
        if (match[5]) {
          match[5].split(';').forEach(p => {
            const [k, v] = p.split('=');
            if (k && v) codecInfo.params[k.trim()] = v.trim();
          });
        }
        remoteCodecs.push(codecInfo);
      }
    }
  }
  
  console.log('📊 Local codecs:', localCodecs.length, localCodecs.map(c => c.codec).join(','));
  console.log('📊 Remote codecs:', remoteCodecs.length, remoteCodecs.map(c => c.codec).join(','));
  
  // Find first codec that exists in both local and remote (in same order)
  for (const localCodec of localCodecs) {
    const remoteMatch = remoteCodecs.find(rc => 
      rc.codec === localCodec.codec && 
      rc.sampleRate === localCodec.sampleRate && 
      rc.channels === localCodec.channels
    );
    if (remoteMatch) {
      activeCodec = localCodec;
      console.log('📊 Active codec (in both local and remote):', activeCodec);
      break;
    }
  }
  
  // Fallback: use first local codec if no common one found
  if (!activeCodec && localCodecs.length > 0) {
    activeCodec = localCodecs[0];
    console.log('📊 No common codec found, using first local codec:', activeCodec);
  }

  // Extract RTCP_STATS line (JSON format) - but parseRtcpSummaryLine handles this now
  // Keep this for Socket.IO broadcasting only
  const statsMatch = data.match(/RTCP_STATS:\s*(\{[^\n]+\})/);
  let stats: any = {};
  if (statsMatch) {
    try {
      stats = JSON.parse(statsMatch[1]);
      
      // Broadcast stats to all connected UI clients via Socket.IO
      const socketConnection = getBaresipConnection();
      if (socketConnection && socketConnection.io) {
        socketConnection.io.emit('rtcp_stats', stats);
      }
    } catch (e) {
      console.error('❌ Failed to parse RTCP_STATS JSON:', statsMatch[1], e);
    }
  }

  // Try to find the call and update it
  if (callId || activeCodec || Object.keys(stats).length > 0) {
    const calls = stateManager.getCalls();
    let updates: any = {};
    if (activeCodec) updates.audioCodec = activeCodec;
    // Store both local and remote codecs for potential RX/TX differentiation
    if (localCodecs.length > 0 || remoteCodecs.length > 0) {
      updates.audioCodecs = localCodecs; // Store as reference
      updates.rxAudioCodec = remoteCodecs.length > 0 ? remoteCodecs[0] : undefined;
      updates.txAudioCodec = localCodecs.length > 0 ? localCodecs[0] : undefined;
    }
    if (Object.keys(stats).length > 0) {
      // Map new JSON stats to UI fields
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
    }
    // Use callId from old format
    if (callId) {
      stateManager.updateCall(callId, updates);
      console.log(`📊 Updated call ${callId} with codec`, updates);
    } else if (calls.length === 1 && activeCodec) {
      stateManager.updateCall(calls[0].callId, updates);
      console.log(`📊 Updated single active call ${calls[0].callId} with codec`, updates);
    }
  }
}

function parseGetRtcpStatsResponse(data: string, stateManager: StateManager): void {
  try {
    console.log('📊 parseGetRtcpStatsResponse called with data length:', data.length);
    
    // Parse JSON array directly (data is already the JSON string from response.data)
    const stats_array = JSON.parse(data);
    
    if (!Array.isArray(stats_array)) {
      console.log('📊 Response is not an array:', typeof stats_array);
      return;
    }
    
    console.log('📊 Parsing', stats_array.length, 'call stats');
    
    for (const stats of stats_array) {
      const callId = stats.call_id;
      if (!callId) {
        console.log('📊 No call_id in stats:', JSON.stringify(stats).substring(0, 50));
        continue;
      }
      
      const call = stateManager.getCall(callId);
      if (!call) {
        console.log('📊 Call not found:', callId);
        continue;
      }
      
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
      console.log(`📊 Updated call ${callId} with RTCP stats`);
    }
  } catch (error) {
    console.debug('[parseGetRtcpStatsResponse] Error:', error);
  }
}

export function parseGetRtcpStatsResponse_exported(data: string, stateManager: StateManager): void {
  parseGetRtcpStatsResponse(data, stateManager);
}

function parseCallsResponse(data: string, stateManager: StateManager, autoReset: boolean = false): void {
  const cleanData = data.replace(/\x1b\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
  const lines = cleanData.split('\n');
  
  // Parse active calls and update account status
  // Format examples from baresip v3.16.0:
  // "call: #1 <sip:2061616@sip.srgssr.ch> <sip:2061531@sip.srgssr.ch> [ESTABLISHED] id=abc123"
  // Or older format: "=== Call 1: sip:2061616@sip.srgssr.ch -> sip:2061531@sip.srgssr.ch [ESTABLISHED]"
  const activeCallIds: Set<string> = new Set();
  let foundAnyCall = false;
  for (const line of lines) {
    if ((line.includes('call:') || line.includes('=== Call')) && line.includes('sip:')) {
      foundAnyCall = true;
      // Try new format first: call: #1 <local> <remote> [STATE] id=xxx
      let match = line.match(/<(sip:[^@\s]+@[^\s>]+)>\s*<(sip:[^@\s]+@[^\s>]+)>\s*\[([^\]]+)\](?:.*id[=:]([^\s]+))?/i);
      // Try older format: === Call N: local -> remote [STATE]
      if (!match) {
        match = line.match(/sip:([^@\s]+@[^\s>]+).*->.*sip:([^@\s]+@[^\s\[]+)\s*\[([^\]]+)\]/i);
        if (match) {
          match = [`sip:${match[1]}`, `sip:${match[1]}`, `sip:${match[2]}`, match[3], undefined];
        }
      }
      if (match) {
        const localUri = match[1];
        const remoteUri = match[2];
        const callState = match[3].trim().toUpperCase();
        const callId = match[4] || `${localUri}->${remoteUri}`; // Fallback-ID
        activeCallIds.add(callId);
        console.log(`Found active call: ${localUri} -> ${remoteUri} [${callState}] ID=${callId}`);
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
        // Direction heuristik: Wenn localUri == eigenem Account, outgoing
        if (account && account.autoConnectContact) {
          callDirection = 'outgoing';
        }
        // Updates für Account
        const updates: any = { callStatus };
        if (callId) updates.callId = callId;
        if (account && account.autoConnectContact) {
          updates.autoConnectStatus = (callState === 'ESTABLISHED') ? 'Connected' : 'Connecting';
        }
        if (account && localUri) {
          stateManager.updateAccountStatus(String(localUri).toLowerCase().trim(), updates);
        }
        // Call-Objekt: update, wenn vorhanden, sonst add
        const existingCall = stateManager.getCall(callId);
        const callObj = {
          callId,
          localUri,
          remoteUri,
          peerName: remoteUri.split('@')[0],
          state: callState === 'ESTABLISHED' ? 'Established' : 'Ringing',
          direction: callDirection,
          startTime: Date.now(),
          answerTime: callState === 'ESTABLISHED' ? Date.now() : undefined
        };
        if (existingCall) {
          stateManager.updateCall(callId, callObj);
        } else {
          stateManager.addCall(callObj);
        }
      }
    }
  }
  
  
  // Auto-Reset only if explicitly enabled (default: disabled)
  if (autoReset) {
    const allAccounts = stateManager.getAccounts();
    const accountsWithCalls = new Set<string>();
    for (const line of lines) {
      if ((line.includes('call:') || line.includes('=== Call')) && line.includes('sip:')) {
        const match = line.match(/<(sip:[^@\s]+@[^\s>]+)>/) || line.match(/sip:([^@\s]+@[^\s>]+)/);
        if (match) {
          const uri = match[1].toLowerCase().trim();
          accountsWithCalls.add(uri);
        }
      }
    }
    
    for (const account of allAccounts) {
      const accountUri = String(account.uri || '').toLowerCase().trim();
      if (!accountsWithCalls.has(accountUri) && account.callStatus !== 'Idle') {
        stateManager.updateAccountStatus(accountUri, { 
          callStatus: 'Idle',
          callId: undefined 
        });
      }
    }
  }
}

function handleJsonEvent(jsonEvent: BaresipEvent, stateManager: StateManager): void {
  const timestamp = Date.now();

  console.log(`JSON Event: ${JSON.stringify(jsonEvent)}`);
  console.log(`DEBUG: Event check - event: ${jsonEvent.event}, class: ${jsonEvent.class}, type: ${jsonEvent.type}`);

  // Add log entry
  stateManager.addLog('event', `${jsonEvent.class}:${jsonEvent.type}`, jsonEvent);

  // Don't broadcast VU_TX_REPORT and similar events as logs
  // These are handled internally and would clutter the log view
  if (jsonEvent.type !== 'VU_TX_REPORT' && jsonEvent.type !== 'VU_RX_REPORT') {
    stateManager.broadcast({
      type: 'log',
      timestamp,
      message: JSON.stringify(jsonEvent)
    });
  }

  if (jsonEvent.event && jsonEvent.class === 'ua') {
    console.log('DEBUG: Event condition matched - processing UA event');
    if (jsonEvent.type === 'REGISTER_OK') {
      const uri = jsonEvent.accountaor;
      console.log(`DEBUG: Processing REGISTER_OK for URI: ${uri}`);
      if (uri) {
        console.log(`DEBUG: Calling updateAccountStatus for ${uri}`);
        stateManager.updateAccountStatus(uri, {
          registered: true,
          registrationError: undefined
        });
        
        // Check if auto-connect should be triggered immediately
        checkAutoConnectForAccount(uri, stateManager);
      }
    } else if (jsonEvent.type === 'REGISTER_FAIL') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        let errorStatus = 'Registration Error';
        if (jsonEvent.param) {
          const cleanParam = jsonEvent.param.replace(/\s*\[\d+\]\s*$/, '').trim();
          if (cleanParam.length > 0) {
            errorStatus = cleanParam;
          }
        }
        stateManager.updateAccountStatus(uri, {
          registered: false,
          registrationError: errorStatus,
          lastRegistrationAttempt: timestamp
        });
      }
    } else if (jsonEvent.type === 'UNREGISTERING') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        stateManager.updateAccountStatus(uri, { registered: false });
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
        console.log(`Loaded configured account from API: ${uri}`);

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
        console.log(`[CALL_ESTABLISHED] Account: ${uri}, Call ID: ${jsonEvent.id}, Peer: ${peerUri}`);
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
      }
    } else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri;
      
      if (uri) {
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
        
        stateManager.updateAccountStatus(uri, { 
          callStatus: 'Idle',
          autoConnectStatus: 'Off',
          callId: undefined
        });
        
        // Immediately reconnect if auto-connect is configured
        checkAutoConnectForAccount(uri, stateManager);
      }
    }
  }
}

function parseRtcpSummaryLine(line: string, stateManager: StateManager): void {
  // Parse RTCP stats from rtcpstats_periodic module
  // NEW JSON Format: RTCP_STATS: {...full JSON...}
  // SHORT Format: rtcpstats_periodic: call_id=xxx rx_packets=123 tx_packets=456 rx_bitrate_kbps=0 tx_bitrate_kbps=1 rx_dropout=false rx_dropout_total=0
  // OLD Format: "RTCP_STATS: call_id=xxx;media=audio;packets_rx=123;..."
  
  console.log('🔍 parseRtcpSummaryLine called with:', line.substring(0, 100));
  
  if (!line.includes('RTCP') && !line.includes('rtcpstats')) return;
  
  // Try JSON format first
  if (line.includes('RTCP_STATS:')) {
    const jsonMatch = line.match(/RTCP_STATS:\s*(\{.+\})/);
    if (jsonMatch) {
      try {
        const stats = JSON.parse(jsonMatch[1]);
        const callId = stats.call_id;
        
        if (!callId) {
          console.log('⚠️ No call_id in RTCP_STATS JSON');
          return;
        }
        
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
        console.log(`📊 Updated call ${callId} with RTCP_STATS JSON`);
        return;
      } catch (e) {
        console.log('⚠️ Failed to parse RTCP_STATS JSON, trying short format...');
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
      console.log(`📊 Updated call ${callId} with short RTCP format:`, updates);
      return;
    }
  }
  
  // Fallback to OLD semicolon-delimited format (for compatibility)
  console.log('📊 Trying old RTCP stats format:', line);
  
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
    console.log(`📊 Updated call ${callId} with RTCP stats:`, updates);
  }
}

function parseCallStatLine(line: string, stateManager: StateManager): void {
  // Parse RTP statistics from Baresip callstat output
  console.log('📊 Parsing call stat line:', line);
  
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
    
    console.log(`📊 Parsed ${isRx ? 'RX' : 'TX'} stats:`, stats);
    
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
      console.log(`Updated call ${callId} ${isRx ? 'RX' : 'TX'} stats:`, stats);
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
        console.log(`Updated call ${calls[0].callId} ${isRx ? 'RX' : 'TX'} stats:`, stats);
      }
    }
  }
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
    // This is likely a getrtcpstats JSON response line
    console.log('📊 getrtcpstats line detected:', line.substring(0, 100));
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

  // DEBUG: Check if enhanced_presence messages arrive here
  if (line.indexOf('enhanced_presence:') !== -1) {
    console.log('DEBUG: Enhanced presence line detected:', line);
  }
  
  // Handle PRESENCE_EVENT messages from enhanced_presence module
  if (line.indexOf('PRESENCE_EVENT:') !== -1) {
    console.log('DEBUG: PRESENCE_EVENT detected:', line);
    const parts = line.split(':');
    if (parts.length >= 3) {
      const contact = parts[1];
      const status = parts[2].toLowerCase();
      
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
      
      console.log(`PRESENCE_EVENT parsed: ${contact} -> ${mappedStatus}`);
      stateManager.setContactPresence(contact, mappedStatus);

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: mappedStatus
      });
    }
  }

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: line
  });

  if (line.includes('registered successfully')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, {
        registered: true,
        registrationError: undefined
      });
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
      console.log(`Registration error for ${uri}: ${errorStatus}`);
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
        console.log(`Found account in reg message: ${uri}`);

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
    }
  } else if (line.includes('presence:') && line.includes('open')) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1];
      stateManager.setContactPresence(contact, 'online');

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: 'online'
      });

      const config = stateManager.getContactConfig(contact);
      if (config?.enabled) {
        attemptAutoConnect(contact, stateManager);
      }
    }
  } else if (line.includes('presence:') && (line.includes('closed') || line.includes('offline'))) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1];
      stateManager.setContactPresence(contact, 'offline');

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
          const contact = presenceEvent.contact.replace('sip:', '');
          const status = presenceEvent.status;
          
          console.log(`Enhanced presence JSON detected: ${contact} -> ${status}`);
          stateManager.setContactPresence(contact, status);

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
      
      console.log(`Enhanced presence detected: ${contact} -> ${status}`);
      stateManager.setContactPresence(contact, status);

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
          console.log(`Loaded configured account from text: ${uri} displayName: ${name}`);

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
    if (account.autoConnectContact === contact && account.registered && account.callStatus === 'Idle') {
      // Check if contact is online (not busy - we want only one call per contact)
      const contactPresence = stateManager.getContactPresence(contact);
      if (contactPresence === 'online') {
        console.log(`Queueing auto-connect: ${account.uri} to ${contact}...`);
        
        // Add to queue to prevent race conditions with uafind
        autoConnectQueue.push(() => {
          // Double-check status before executing (might have changed while in queue)
          const currentAccount = stateManager.getAccount(account.uri);
          if (!currentAccount || currentAccount.callStatus !== 'Idle') {
            console.log(`Skipping auto-connect for ${account.uri} - no longer idle`);
            return;
          }
          
          console.log(`Executing auto-connect: ${account.uri} to ${contact}...`);
          
          const runtimeConfig = useRuntimeConfig();
          const connection = getBaresipConnection(runtimeConfig.baresipHost, parseInt(runtimeConfig.baresipPort));
          
          // Select account and dial sequentially
          console.log(`Step 1: Selecting account ${account.uri}`);
          connection.sendCommand('uafind', account.uri);
          
          // Wait for account selection before dialing
          setTimeout(() => {
            console.log(`Step 2: Dialing ${contact} from ${account.uri}`);
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
  console.log(`checkAutoConnectForAccount called for ${accountUri}`);
  
  if (!account) {
    console.log(`  -> No account found`);
    return;
  }
  if (!account.autoConnectContact) {
    console.log(`  -> No autoConnectContact configured`);
    return;
  }
  if (!account.registered) {
    console.log(`  -> Account not registered`);
    return;
  }
  if (account.callStatus !== 'Idle') {
    console.log(`  -> Account not idle (status: ${account.callStatus})`);
    return;
  }

  // Check if the contact is online (not busy - we want only one call per contact)
  const contactPresence = stateManager.getContactPresence(account.autoConnectContact);
  console.log(`  -> Contact ${account.autoConnectContact} presence: ${contactPresence}`);
  
  if (contactPresence === 'online') {
    console.log(`Account ${accountUri} is ready, attempting auto-connect to ${account.autoConnectContact}`);
    attemptAutoConnect(account.autoConnectContact, stateManager);
  } else {
    console.log(`  -> Not connecting: contact is not online (${contactPresence})`);
  }
}
