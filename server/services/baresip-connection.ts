import net from 'node:net';
import { createNetstring } from '../utils/netstring';
import { stateManager } from './state-manager';
import { parseBaresipEvent } from './baresip-parser';
import { getAutoConnectConfigManager } from './autoconnect-config';

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

    // Parser for 'callstat' response
    private parseCallStatResponse(data: string): void {
      // Beispiel callstat-Antwort:
      // call: #1 <sip:alice@domain> <sip:bob@domain> [ESTABLISHED] id=abc123
      // audio: opus/48000/2 ptime=20 maxaveragebitrate=128000
      // RTCP_STATS: packets_rx=123 packets_tx=456 lost_rx=7 lost_tx=2 jitter_rx=12.3 jitter_tx=10.1 rtt=45.6
      // (ggf. weitere Zeilen)

      console.debug('[parseCallStatResponse] Raw data:', data);
      const lines = data.split('\n');
      let callId: string | undefined;
      let audioCodec: any = undefined;
      let audioRxStats: any = undefined;
      let audioTxStats: any = undefined;

      for (const line of lines) {
        // CallId extrahieren
        const callMatch = line.match(/id[=:]([\w\d]+)/);
        if (callMatch) {
          callId = callMatch[1];
        }
        // Audio-Codec-Zeile parsen
        const audioMatch = line.match(/^audio:\s*([\w\d\-]+)/i);
        if (audioMatch) {
          // z.B. "opus/48000/2"
          const codecLine = line.replace('audio: ', '').trim();
          const [codecPart, ...paramParts] = codecLine.split(' ');
          const [codec, sampleRate, channels] = codecPart.split('/');
          const params: Record<string, string> = {};
          paramParts.forEach(p => {
            const [k, v] = p.split('=');
            if (k && v) params[k] = v;
          });
          audioCodec = {
            codec,
            sampleRate: sampleRate ? Number(sampleRate) : undefined,
            channels: channels ? Number(channels) : undefined,
            params: Object.keys(params).length > 0 ? params : undefined
          };
        }
        // RTCP_STATS parsen
        const statsMatch = line.match(/RTCP_STATS:\s*([^\n]+)/);
        if (statsMatch) {
          const statsStr = statsMatch[1];
          const stats: any = {};
          statsStr.split(/\s+/).forEach(pair => {
            const [key, value] = pair.split('=');
            stats[key] = isNaN(Number(value)) ? value : Number(value);
          });
          // RX-Stats
          audioRxStats = {
            packets: stats.packets_rx ?? 0,
            packetsLost: stats.lost_rx ?? 0,
            jitter: stats.jitter_rx ?? 0,
            bitrate: audioCodec?.params?.maxaveragebitrate ? Number(audioCodec.params.maxaveragebitrate) : 0
          };
          // TX-Stats
          audioTxStats = {
            packets: stats.packets_tx ?? 0,
            packetsLost: stats.lost_tx ?? 0,
            bitrate: audioCodec?.params?.maxaveragebitrate ? Number(audioCodec.params.maxaveragebitrate) : 0
          };
        }
      }
      if (callId) {
        const update: any = {};
        if (audioCodec) update.audioCodec = audioCodec;
        if (audioRxStats) update.audioRxStats = audioRxStats;
        if (audioTxStats) update.audioTxStats = audioTxStats;
        if (Object.keys(update).length > 0) {
          stateManager.updateCall(callId, update);
          console.debug('[parseCallStatResponse] Updated call:', callId, update);
        }
      } else {
        console.debug('[parseCallStatResponse] No callId found in callstat response:', data);
      }
    }
  private client: net.Socket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000;
  private contactsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CONTACTS_POLL_INTERVAL = 5000; // Poll contacts every 5 seconds
  private callStatsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CALL_STATS_POLL_INTERVAL = 2000; // Poll call stats every 2 seconds

  constructor(
    private host: string,
    private port: number
  ) {}

  async connect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
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

      this.sendCommand('contacts');
      this.sendCommand('listcalls');
      this.sendCommand('callstat');  // Query active calls on startup
      this.sendCommand('about');    // get baresip version
      this.sendCommand('reginfo'); // registration info
      this.sendCommand('sysinfo'); // user system information
      this.sendCommand('uastat'); // user agent statistics
      

      // Start polling contacts for presence updates
      this.startContactsPolling();
      // Start polling call statistics
      this.startCallStatsPolling();

      setTimeout(() => {
        console.log(`Accounts loaded via API: ${stateManager.getAccountsSize()}`);
        console.log(`Contacts loaded via API: ${stateManager.getContactsSize()}`);
        
        // Apply saved auto-connect configs to contacts
        this.applySavedConfigs();
      }, 2000);
    });

    this.client.on('data', (data) => {
      parseBaresipEvent(data, stateManager);
    });

    this.client.on('error', (err) => {
      console.error('Baresip connection error:', err.message);
    });

    this.client.on('close', () => {
      console.log('Baresip connection closed');
      stateManager.setBaresipConnected(false);
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

    console.log(`Starting contacts polling (every ${this.CONTACTS_POLL_INTERVAL}ms)`);
    
    // Poll immediately, then at intervals
    this.contactsPollingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.sendCommand('contacts');
        
      //this.sendCommand('listcalls');
      //this.sendCommand('callstat');  // Query active calls on startup
      //this.sendCommand('about');    // get baresip version
      //this.sendCommand('reginfo'); // registration info
      this.sendCommand('sysinfo'); // user system information
      //this.sendCommand('uastat'); // user agent statistics
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
            console.log(`Loaded display name for ${uri}: "${displayName}"`);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load account display names:', err);
    }
  }

  private stopContactsPolling(): void {
    if (this.contactsPollingInterval) {
      console.log('Stopping contacts polling');
      clearInterval(this.contactsPollingInterval);
      this.contactsPollingInterval = null;
    }
  }

  private startCallStatsPolling(): void {
    // Stop any existing polling
    this.stopCallStatsPolling();

    console.log(`📊 Call stats polling enabled - sending 'callstat' command alle 2s wenn Calls aktiv sind`);

    // poll every 2 seconds if there are active calls
    this.callStatsPollingInterval = setInterval(() => {
      if (this.isConnected() && stateManager.getCalls().length > 0) {
        this.sendCommand('callstat');
      }
    }, this.CALL_STATS_POLL_INTERVAL);
  }

  private stopCallStatsPolling(): void {
    if (this.callStatsPollingInterval) {
      console.log('Stopping call stats polling');
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
      console.log(`Sent JSON command: ${jsonString} (as netstring: ${netstring})`);
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
