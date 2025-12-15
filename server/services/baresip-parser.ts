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

export function parseBaresipEvent(data: Buffer, stateManager: StateManager): void {
  const dataStr = data.toString();

  try {
    const netstringMessages = parseNetstring(data);
    if (netstringMessages.length > 0) {
      console.log('Parsed netstring messages:', netstringMessages);

      for (const messageStr of netstringMessages) {
        try {
          const jsonMessage = JSON.parse(messageStr);

          if (jsonMessage.response !== undefined) {
            console.log('DEBUG: Handling command response');
            handleCommandResponse(jsonMessage, stateManager);
          } else if (jsonMessage.event) {
            console.log('DEBUG: Handling JSON event', jsonMessage.type, jsonMessage.class);
            handleJsonEvent(jsonMessage, stateManager);
          } else {
            console.log('Unknown JSON message:', jsonMessage);
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
  console.log('=== Command Response ===');
  const timestamp = Date.now();

  console.log(`Command Response: ${JSON.stringify(response)}`);

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: `Command Response: ${JSON.stringify(response)}`
  });

  if (response.ok && response.data) {
    console.log(`Command executed successfully: ${response.data}`);

    if (typeof response.data === 'string') {
      console.log(`Checking response data for contacts: includes "--- Contacts" = ${response.data.includes('--- Contacts')}`);
      parseApiResponse(response.data, stateManager, response.token);

      if (response.data.includes('--- Contacts')) {
        console.log('Calling parseContactsFromResponse...');
        parseContactsFromResponse(response.data, stateManager);
      }
      
      // Parse active calls to sync call status after restart
      if (response.data.includes('=== Call')) {
        console.log('Calling parseCallsResponse...');
        parseCallsResponse(response.data, stateManager);
      }
      
      // Parse call statistics from callstat command
      if (response.data.includes('Call debug') || response.data.includes('audio RTP')) {
        console.log('📊 Parsing callstat response...');
        parseCallStatResponse(response.data, stateManager);
      }

      const cleanData = response.data.replace(/\\u001B\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
      if (cleanData.includes('User Agents') || response.data.includes('User Agents')) {
        parseRegistrationInfo(cleanData, stateManager);
      }
    }
  } else {
    console.error(`Command failed: ${response.data}`);
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
        const uri = match[1];
        const status = match[2];

        console.log(`Registration status for ${uri}: ${status} (status length: ${status.length}, charCodes: ${Array.from(status).map(c => c.charCodeAt(0)).join(',')})`);

        // Try to extract display name (format: "number - DisplayName <sip:...> STATUS")
        const displayNameMatch = cleanLine.match(/^\s*\d+\s*-\s*(.+?)\s*</);
        const displayName = displayNameMatch ? displayNameMatch[1].trim() : undefined;

        // Get existing account or create a new one
        const account = stateManager.getAccount(uri) || {
          uri,
          registered: false,
          callStatus: 'Idle' as const,
          autoConnectStatus: 'Off',
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

        stateManager.setAccount(uri, account);

        stateManager.broadcast({
          type: 'accountStatus',
          data: account
        });

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
        
        // Entfernt: Kein Überschreiben von account.displayName durch Kontaktnamen
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

  // Extract codec from "local formats" section (find all codecs, mark active)
  const localFormatsSection = data.split('local formats:')[1]?.split('remote formats:')[0] || '';
  let activeCodec: any = null;
  let codecs: any[] = [];
  if (localFormatsSection) {
    // Zeilenweise durchsuchen
    const lines = localFormatsSection.split('\n');
    for (const line of lines) {
      // Beispiel: "     96 opus/48000/2 (stereo=1;sprop-stereo=1;maxaveragebitrate=128000) *"
      const match = line.match(/\s*(\d+)\s+([A-Za-z0-9]+)\/(\d+)\/(\d+)\s*\(([^)]*)\)\s*(\*)?/);
      if (match) {
        const payloadType = match[1];
        const codecName = match[2];
        const sampleRate = match[3];
        const channels = match[4];
        const params = match[5];
        const isActive = !!match[6];
        const paramObj: Record<string, string> = {};
        params.split(';').forEach(p => {
          const [k, v] = p.split('=');
          if (k && v) paramObj[k.trim()] = v.trim();
        });
        const codecInfo = {
          payloadType,
          codec: codecName,
          sampleRate: Number(sampleRate),
          channels: Number(channels),
          params: paramObj,
          isActive
        };
        codecs.push(codecInfo);
        if (isActive) activeCodec = codecInfo;
      }
    }
    if (activeCodec) {
      console.log('📊 Aktiver Codec:', activeCodec);
    }
    if (codecs.length > 0) {
      console.log('📊 Alle Codecs:', codecs);
    }
  }

  // Extract RTCP_STATS line (example: RTCP_STATS: packets_rx=123 packets_tx=456 lost_rx=7 lost_tx=2 jitter_rx=12.3 jitter_tx=10.1 rtt=45.6)
  const statsMatch = data.match(/RTCP_STATS:\s*([^\n]+)/);
  let stats: any = {};
  if (statsMatch) {
    const statsStr = statsMatch[1];
    // Parse key=value pairs
    const pairs = statsStr.split(/\s+/);
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) {
        // Convert to number if possible
        stats[key] = isNaN(Number(value)) ? value : Number(value);
      }
    }
    console.log('📊 Extracted RTCP_STATS:', stats);
  }

  // Try to find the call and update it
  if (callId || activeCodec || codecs.length > 0 || Object.keys(stats).length > 0) {
    const calls = stateManager.getCalls();
    let updates: any = {};
    if (activeCodec) updates.audioCodec = activeCodec;
    if (codecs.length > 0) updates.audioCodecs = codecs;
    if (Object.keys(stats).length > 0) {
      // Map stats to UI fields
      updates.audioRxStats = {
        packets: stats.packets_rx ?? 0,
        packetsLost: stats.lost_rx ?? 0,
        jitter: stats.jitter_rx ?? 0,
        rtt: stats.rtt ?? 0,
      };
      updates.audioTxStats = {
        packets: stats.packets_tx ?? 0,
        packetsLost: stats.lost_tx ?? 0,
        jitter: stats.jitter_tx ?? 0,
      };
    }
    if (callId) {
      stateManager.updateCall(callId, updates);
      console.log(`📊 Updated call ${callId} with`, updates);
    } else if (calls.length === 1) {
      stateManager.updateCall(calls[0].callId, updates);
      console.log(`📊 Updated call ${calls[0].callId} with`, updates);
    }
  }
}

function parseCallsResponse(data: string, stateManager: StateManager): void {
  console.log('Parsing calls response to sync call status...');
  const cleanData = data.replace(/\x1b\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
  const lines = cleanData.split('\n');
  
  // Parse active calls and update account status
  // Format examples from baresip v3.16.0:
  // "call: #1 <sip:2061616@sip.srgssr.ch> <sip:2061531@sip.srgssr.ch> [ESTABLISHED] id=abc123"
  // Or older format: "=== Call 1: sip:2061616@sip.srgssr.ch -> sip:2061531@sip.srgssr.ch [ESTABLISHED]"
  for (const line of lines) {
    if ((line.includes('call:') || line.includes('=== Call')) && line.includes('sip:')) {
      console.log(`Parsing call line: "${line}"`);
      
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
        const callId = match[4]; // May be undefined
        
        console.log(`Found active call: ${localUri} -> ${remoteUri} [${callState}] ID=${callId || 'unknown'}`);
        
        // Update account call status
        const account = stateManager.getAccount(localUri);
        if (account) {
          const callStatus = (callState === 'ESTABLISHED') ? 'In Call' : 'Ringing';
          const updates: any = { callStatus };
          
          // Only set callId if we found one
          if (callId) {
            updates.callId = callId;
          }
          
          // Update autoConnectStatus if this account has auto-connect configured
          if (account.autoConnectContact) {
            updates.autoConnectStatus = (callState === 'ESTABLISHED') ? 'Connected' : 'Connecting';
          }
          
          stateManager.updateAccountStatus(localUri, updates);
          console.log(`Updated ${localUri} status: callStatus=${callStatus}, callId=${callId || 'none'}, autoConnectStatus=${updates.autoConnectStatus || 'unchanged'}`);
        }
      }
    }
  }
  
  console.log('Call status sync complete');
}

function parseApiResponse(data: string, stateManager: StateManager, token?: string): void {
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes('sip:') && line.includes('@')) {
      const match = line.match(/(sip:[^@\s]+@[^\s>;,)]+)/);
      if (match) {
        const uri = match[1];

        // Nur Accounts aus der Contact-Liste erstellen, aber NICHT als Account hinzufügen
        // Diese werden nur für Auto-Connect verwendet
        if (!stateManager.hasAccount(uri)) {
          console.log(`Found contact (not adding as account): ${uri}`);
          // Wir erstellen hier KEINEN Account mehr für Kontakte
        }
      }
    }

    if (line.includes('<sip:')) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      console.log(`Parsing contact line: "${cleanLine}"`);
      const match = cleanLine.match(/(?:"([^"]+)"\s*|([^<\u001b]+?))\s*<(sip:[^@]+@[^>]+)>/);
      if (match) {
        const name = (match[1] || match[2] || 'Unknown').trim();
        const contact = match[3];
        console.log(`Found contact match: name="${name}", contact="${contact}"`);

        if (!stateManager.hasContactConfig(contact)) {
          const contactConfig = {
            name: name,
            enabled: false,
            status: 'Off',
            source: 'api'
          };

          stateManager.setContactConfig(contact, contactConfig);
          console.log(`Loaded contact from API: ${name} <${contact}>`);
        }
      }
    }
  }

  if (stateManager.getContactsSize() > 0) {
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

function handleJsonEvent(jsonEvent: BaresipEvent, stateManager: StateManager): void {
  const timestamp = Date.now();

  console.log(`JSON Event: ${JSON.stringify(jsonEvent)}`);
  console.log(`DEBUG: Event check - event: ${jsonEvent.event}, class: ${jsonEvent.class}, type: ${jsonEvent.type}`);

  // Add log entry
  stateManager.addLog('event', `${jsonEvent.class}:${jsonEvent.type}`, jsonEvent);

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: JSON.stringify(jsonEvent)
  });

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
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri || jsonEvent.peer_uri;
      const peerUri = jsonEvent.peeruri || jsonEvent.peer_uri || jsonEvent.remote_uri;
      
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
          peerName: jsonEvent.peername || peerUri?.split('@')[0] || 'Unknown',
          state: 'Established',
          direction: jsonEvent.direction || 'unknown',
          startTime: jsonEvent.param?.includes('incoming') ? Date.now() - 1000 : Date.now(),
          answerTime: Date.now(),
          // Add mock statistics for testing
          audioCodec: 'PCMU/8000',
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
    } else if (jsonEvent.type === 'CALL_RINGING' || jsonEvent.type === 'CALL_INCOMING' || jsonEvent.type === 'CALL_OUTGOING') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri || jsonEvent.peer_uri;
      const peerUri = jsonEvent.peeruri || jsonEvent.peer_uri || jsonEvent.remote_uri;
      
      if (uri && jsonEvent.id) {
        const updates: any = { 
          callStatus: 'Ringing',
          callId: jsonEvent.id
        };
        
        // Add call to tracking in Ringing state
        stateManager.addCall({
          callId: jsonEvent.id,
          localUri: uri,
          remoteUri: peerUri || 'unknown',
          peerName: jsonEvent.peername || peerUri?.split('@')[0] || 'Unknown',
          state: 'Ringing',
          direction: jsonEvent.type === 'CALL_INCOMING' ? 'incoming' : 'outgoing',
          startTime: Date.now()
        });
        
        // Check if this is an auto-connect call
        const account = stateManager.getAccount(uri);
        if (account && account.autoConnectContact) {
          updates.autoConnectStatus = 'Connecting';
        }
        
        stateManager.updateAccountStatus(uri, updates);
        console.log(`[CALL_RINGING] Account: ${uri}, Call ID: ${jsonEvent.id}, Direction: ${jsonEvent.type}, Peer: ${peerUri}`);
      }
    } else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.localuri || jsonEvent.local_uri || jsonEvent.peer_uri;
      
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
        console.log(`[CALL_CLOSED] Account: ${uri}, Call ID: ${jsonEvent.id}`);
        
        // Immediately reconnect if auto-connect is configured
        checkAutoConnectForAccount(uri, stateManager);
      }
    }
  }
}

function parseRtcpSummaryLine(line: string, stateManager: StateManager): void {
  // Parse RTCP stats from rtcpstats_periodic module
  // Format: "RTCP_STATS: call_id=xxx;media=audio;packets_rx=123;packets_tx=456;lost_rx=0;lost_tx=0;jitter_rx=12.5;jitter_tx=10.2;rtt=45.3;"
  
  if (!line.includes('RTCP_STATS:')) return;
  
  console.log('📊 Parsing RTCP stats line:', line);
  
  const callIdMatch = line.match(/call_id=([^;]+)/);
  const mediaMatch = line.match(/media=([^;]+)/);
  const packetsRxMatch = line.match(/packets_rx=(\d+)/);
  const packetsTxMatch = line.match(/packets_tx=(\d+)/);
  const lostRxMatch = line.match(/lost_rx=(-?\d+)/);
  const lostTxMatch = line.match(/lost_tx=(-?\d+)/);
  const jitterRxMatch = line.match(/jitter_rx=([\d.]+)/);
  const jitterTxMatch = line.match(/jitter_tx=([\d.]+)/);
  const rttMatch = line.match(/rtt=([\d.]+)/);
  
  if (callIdMatch && packetsRxMatch) {
    const callId = callIdMatch[1];
    const media = mediaMatch ? mediaMatch[1] : 'audio';
    
    const updates: any = {};
    
    // RX Stats
    if (packetsRxMatch) {
      const rxStats = {
        packets: parseInt(packetsRxMatch[1]),
        packetsLost: lostRxMatch ? parseInt(lostRxMatch[1]) : 0,
        jitter: jitterRxMatch ? parseFloat(jitterRxMatch[1]) : 0,
        bitrate: 0 // Will be calculated or updated elsewhere
      };
      
      if (media === 'audio') {
        updates.audioRxStats = rxStats;
      } else if (media === 'video') {
        updates.videoRxStats = rxStats;
      }
    }
    
    // TX Stats
    if (packetsTxMatch) {
      const txStats = {
        packets: parseInt(packetsTxMatch[1]),
        packetsLost: lostTxMatch ? parseInt(lostTxMatch[1]) : 0,
        bitrate: 0
      };
      
      if (media === 'audio') {
        updates.audioTxStats = txStats;
      } else if (media === 'video') {
        updates.videoTxStats = txStats;
      }
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

  // Filter out audio bitrate statistics (will be handled via dedicated WebSocket later)
  if (line.match(/\[\d+:\d+:\d+\]\s+audio=\d+\/\d+\s+\(bit\/s\)/)) {
    return; // Silently ignore audio statistics
  }

  // Parse RTCP summary statistics (from rtcpsummary module)
  // Example: "RTCP Summary: tx=1234 packets, lost=5, jitter=12.5ms, rtt=50ms"
  if (line.includes('RTCP') || line.includes('rtcp')) {
    parseRtcpSummaryLine(line, stateManager);
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
