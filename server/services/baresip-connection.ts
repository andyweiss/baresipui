import net from 'node:net';
import { createNetstring } from '../utils/netstring';
import { stateManager } from './state-manager';
import { parseBaresipEvent, parseBaresipEventBuffered } from './baresip-parser';
import { getAutoConnectConfigManager } from './autoconnect-config';
import { getBaresipLogger } from '../utils/logger';

export class BaresipConnection {
    // Parser for 'contacts' response
    private parseContactsResponse(data: string): void {
      const lines = data.split('\n');
      for (const line of lines) {
        const match = line.match(/<sip:([^>]+)>/);
        if (match) {
          const contact = `sip:${match[1]}`;
          // Optionally extract name
          const nameMatch = line.match(/^([^<]+)</);
          const name = nameMatch ? nameMatch[1].trim() : contact;
          stateManager.setContactConfig(contact, { name, enabled: true, status: 'Unknown', source: 'baresip' });
        }
      }
      stateManager.broadcast({ type: 'contactsUpdate', contacts: stateManager.getContacts() });
    }

    /**
     * Parses the response from the 'listcalls' command and updates the state manager.
     * Example line: "call: #1 <sip:alice@domain> <sip:bob@domain> [ESTABLISHED] id=abc123"
     */
    private parseListCallsResponse(data: string): void {
      console.debug('[parseListCallsResponse] Raw data:', data);
      const lines = data.split('\n');
      for (const line of lines) {
        // Try to match local and remote URI, state, and callId
        const match = line.match(/<(sip:[^>]+)>\s*<(sip:[^>]+)>\s*\[(\w+)\][^\n]*id[=:]([^\s]+)/);
        if (match) {
          const localUri = match[1] || null;
          const remoteUri = match[2] || null;
          const state = match[3] || 'Unknown';
          const callId = match[4] || null;
          console.debug('[parseListCallsResponse] Parsed:', { callId, localUri, remoteUri, state });
          stateManager.addCall({ callId, localUri, remoteUri, state, startTime: Date.now() });
        } else if (line.trim()) {
          console.debug('[parseListCallsResponse] No match for line:', line);
        }
      }
      // Broadcast the updated calls list
      stateManager.broadcast({ type: 'callsUpdate', calls: stateManager.getCalls() });
    }

    // Parser for 'getrtcpstats' response (JSON array)
    private parseGetRtcpStatsResponse(data: string): void {
      try {
        const cleanData = data.trim().replace(/[\[\]]/g, '').trim();
        if (!cleanData) return;
        
        // Split multiple JSON objects
        const jsonObjects = cleanData.split('},').map((obj, idx, arr) => {
          if (idx === arr.length - 1) return obj + '}';
          return obj + '}';
        }).filter(obj => obj.trim().startsWith('{'));
        
        for (const jsonStr of jsonObjects) {
          try {
            const stats = JSON.parse(jsonStr);
            const callId = stats.call_id;
            if (!callId) continue;
            
            const call = stateManager.getCall(callId);
            if (!call) continue;
            
            // Update RX stats
            if (!call.audioRxStats) {
              call.audioRxStats = { packets: 0, lost: 0, bitrate_kbps: 0, dropout: false, dropout_total: 0, rtp_rx_errors: 0, jitter: 0 };
            }
            call.audioRxStats.packets = stats.rtp_rx_packets ?? 0;
            call.audioRxStats.lost = stats.rtcp_lost_rx ?? 0;
            call.audioRxStats.bitrate_kbps = stats.rx_bitrate_kbps ?? 0;
            call.audioRxStats.dropout = stats.rx_dropout ?? false;
            call.audioRxStats.dropout_total = stats.rx_dropout_total ?? 0;
            call.audioRxStats.rtp_rx_errors = stats.rtp_rx_errors ?? 0;
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
            console.debug('[parseGetRtcpStatsResponse] Updated call:', callId);
          } catch (e) {
            // Skip JSON parse errors
          }
        }
      } catch (error) {
        console.debug('[parseGetRtcpStatsResponse] Error:', error);
      }
    }

  private client: net.Socket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000;
  private contactsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CONTACTS_POLL_INTERVAL = 10000; // Poll contacts/presence every 10 seconds
  private callStatsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CALL_STATS_POLL_INTERVAL = 3000; // Poll RTCP stats every 3 seconds
  private tcpBuffer = ''; // Persistent buffer for fragmented TCP netstrings
  private uafindLock: Promise<void> = Promise.resolve(); // Serialize uafind+command sequences

  constructor(
    private host: string,
    private port: number
  ) {}

  async connect(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners(); // Prevent old close handler from triggering zombie reconnect
      this.client.destroy();
      this.client = null;
    }

    // Load auto-connect config before connecting
    const configManager = getAutoConnectConfigManager();
    await configManager.load();
    console.log('Auto-connect config loaded');

    this.client = new net.Socket();

    this.client.connect(this.port, this.host, () => {
      console.log(`Connected to Baresip at ${this.host}:${this.port}`);
      this.reconnectAttempts = 0;
      stateManager.setBaresipConnected(true);

      // Log successful connection
      try {
        const logger = getBaresipLogger();
        logger.addLog('info', 'tcp-socket', `Connected to baresip at ${this.host}:${this.port}`);
      } catch (e) {
        // Logger might not be ready yet
      }

      
      this.sendCommand('sysinfo'); // system information including baresip version
      this.sendCommand('uastat'); // initial account info - ongoing updates come via REGISTER_OK/FAIL events
      this.sendCommand('contacts');
      this.sendCommand('presence_ts'); // initial presence state
      this.sendCommand('listcalls'); // AFTER uastat so accounts exist
      this.sendCommand('callstat');
      

      // Start polling contacts for presence updates
      this.startContactsPolling();
      // Start polling call statistics
      this.startCallStatsPolling();

      setTimeout(() => {
        // Apply saved auto-connect configs to contacts
        this.applySavedConfigs();
      }, 2000);
    });

    this.client.on('data', (data) => {
      // Accumulate data in persistent buffer to handle TCP fragmentation
      this.tcpBuffer += data.toString();

      // Log received data if debug enabled - BEFORE parsing
      if (process.env.DEBUG_TCP_BUS === 'true') {
        const dataStr = data.toString();
        
        // Always log to console first
        console.log(`[TCP-DEBUG] <<< RECEIVED ${data.length} bytes <<<`);
        console.log(dataStr);
        
        // Try to log to baresip logger
        try {
          const logger = getBaresipLogger();
          logger.addLog('debug', 'tcp-socket', `<<< Received (${data.length} bytes): ${dataStr}`);
        } catch (e) {
          console.error('[TCP-DEBUG] Failed to log to baresip logger:', e);
        }
      }
      
      // Parse all complete netstrings from buffer
      try {
        const result = parseBaresipEventBuffered(this.tcpBuffer, stateManager);
        this.tcpBuffer = result.remaining;
      } catch (e) {
        console.error('Failed to parse baresip event:', e);
        if (process.env.DEBUG_TCP_BUS === 'true') {
          console.error('Raw data was:', data.toString());
        }
      }
    });

    this.client.on('error', (err) => {
      console.error('Baresip connection error:', err.message);
      
      // Log TCP error
      try {
        const logger = getBaresipLogger();
        logger.addLog('error', 'tcp-socket', `Connection error: ${err.message}`);
      } catch (e) {
        // Logger might not be available
      }
    });

    this.client.on('close', () => {
      console.log('Baresip connection closed');
      stateManager.setBaresipConnected(false);
      
      // Log TCP disconnect
      try {
        const logger = getBaresipLogger();
        logger.addLog('warn', 'tcp-socket', 'Disconnected from baresip');
      } catch (e) {
        // Logger might not be available
      }
      
      this.tcpBuffer = ''; // Clear buffer on disconnect
      this.stopContactsPolling();
      this.stopCallStatsPolling();
      this.scheduleReconnect();
      // clear all calls on disconnect
      stateManager.clearCalls();
      stateManager.setAllCallStatus('Idle');
    });
  }

  private startContactsPolling(): void {
    // Stop any existing polling
    this.stopContactsPolling();

    // Poll contacts and presence timestamps at intervals
    // Account status updates arrive via JSON events (REGISTER_OK/FAIL) - no uastat polling needed
    this.contactsPollingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.sendCommand('contacts');
        this.sendCommand('presence_ts');
      }
    }, this.CONTACTS_POLL_INTERVAL);
  }

  private async loadAccountDisplayNames(): Promise<void> {
    try {
      const accountsFile = await readFile('/config/accounts', 'utf-8');
      const lines = accountsFile.split('\n');
      
      for (const line of lines) {
        // Skip comments and empty lines
        if (line.trim().startsWith('#') || !line.trim()) continue;
        
        // Match format: DisplayName<sip:...> or <sip:...>
        const match = line.match(/^([^<]+)<(sip:[^@]+@[^>;]+)>/);
        if (match) {
          const displayName = match[1].trim();
          const uri = match[2];
          
          // Get or create account and set display name
          const account = stateManager.getAccount(uri) || {
            uri,
            registered: false,
            callStatus: 'Idle' as const,
            autoConnectStatus: 'Off',
            lastEvent: Date.now(),
            configured: true
          };
          
          if (displayName) {
            account.displayName = displayName;
            stateManager.setAccount(uri, account);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load account display names:', err);
    }
  }

  private stopContactsPolling(): void {
    if (this.contactsPollingInterval) {
      clearInterval(this.contactsPollingInterval);
      this.contactsPollingInterval = null;
    }
  }

  private callStatsQueueIndex = 0; // Track which call to query next

  private startCallStatsPolling(): void {
    // Stop any existing polling
    this.stopCallStatsPolling();

    // Poll every 3 seconds for RTCP stats and check for calls needing codec info
    this.callStatsPollingInterval = setInterval(() => {
      if (this.isConnected()) {
        const calls = stateManager.getCalls();
        
        // Check for calls that need codec info (once per call)
        for (const call of calls) {
          if (call.needsCodecInfo && call.localUri && call.callId) {
            // Fetch codec info and mark as fetched
            this.fetchCodecInfoForCall(call.callId, call.localUri);
            
            // Mark as fetched to avoid fetching again
            stateManager.updateCall(call.callId, {
              needsCodecInfo: false,
              codecInfoFetched: true
            });
          }
        }
        
        // Get RTCP stats for ALL calls (works without account selection)
        if (calls.length > 0) {
          this.sendCommand('getrtcpstats');
        }
      }
    }, this.CALL_STATS_POLL_INTERVAL);
  }

  // Fetch codec info once when call is established
  public fetchCodecInfoForCall(callId: string, localUri: string): void {
    // Use serialized command sequence to prevent uafind race conditions
    this.sendCommandSequence([
      { command: 'uafind', params: localUri },
      { command: 'callstat' }
    ]);
  }

  /**
   * Execute a sequence of commands atomically - prevents uafind interleaving.
   * Commands are sent back-to-back on the same TCP connection.
   * TCP guarantees ordering, so baresip processes them sequentially.
   * The lock prevents other sendCommandSequence calls from interleaving.
   */
  sendCommandSequence(commands: Array<{command: string, params?: string, token?: string}>): void {
    this.uafindLock = this.uafindLock.then(async () => {
      for (const cmd of commands) {
        this.sendCommand(cmd.command, cmd.params, cmd.token);
      }
      // Small yield to ensure TCP write is flushed before releasing lock
      await new Promise(r => setTimeout(r, 10));
    });
  }

  private stopCallStatsPolling(): void {
    if (this.callStatsPollingInterval) {
      clearInterval(this.callStatsPollingInterval);
      this.callStatsPollingInterval = null;
    }
  }

  private applySavedConfigs(): void {
    const configManager = getAutoConnectConfigManager();
    const allConfigs = configManager.getAllConfigs();
    console.log('Applying saved auto-connect configs...');
    for (const [accountUri, config] of Object.entries(allConfigs.accounts)) {
      let account = stateManager.getAccount(accountUri);
      if (!account) {
        // create account object if not existing
        account = {
          uri: accountUri,
          registered: false,
          callStatus: 'Idle',
          autoConnectStatus: 'Off',
          lastEvent: Date.now(),
          configured: true
        };
      }
      if (config.autoConnectContact) {
        account.autoConnectContact = config.autoConnectContact;
      }
      stateManager.setAccount(accountUri, account);
      console.log(`Applied config for ${accountUri}: contact=${config.autoConnectContact}, enabled=${config.enabled}`);
      // Broadcast account update
      stateManager.broadcast({
        type: 'accountStatus',
        data: account
      });
    }
    // After applying all configs: broadcast initial data
    stateManager.broadcast(stateManager.getInitData());
  }

  sendCommand(command: string, params?: string, token?: string): void {
    if (this.client && !this.client.destroyed) {
      const jsonMessage: any = {
        command: command,
        ...(params && { params: params }),
        ...(token && { token: token })
      };
      
      const jsonString = JSON.stringify(jsonMessage);
      const netstring = createNetstring(jsonString);
      
      this.client.write(netstring);
      
      // Debug logging - always log if debug enabled
      if (process.env.DEBUG_TCP_BUS === 'true') {
        console.log(`[TCP-DEBUG] >>> SENT: ${jsonString} >>>`);
      }
      
      // Log to baresip logger (always when debug enabled, otherwise only important commands)
      const shouldLog = process.env.DEBUG_TCP_BUS === 'true' || 
                       !['contacts', 'presence_ts', 'getrtcpstats'].includes(command);
      
      if (shouldLog) {
        try {
          const logger = getBaresipLogger();
          logger.addLog('debug', 'tcp-socket', `>>> Sent command: ${command}${params ? ' ' + params : ''}`);
        } catch (e) {
          // Logger might not be available
        }
      }
    } else {
      console.log(`Cannot send command - client not connected: ${command}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnect attempts reached');
      return;
    }

    const delay = this.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }
}

let baresipConnection: BaresipConnection | null = null;

export function getBaresipConnection(host: string, port: number): BaresipConnection {
  if (!baresipConnection) {
    baresipConnection = new BaresipConnection(host, port);
  }
  return baresipConnection;
}
