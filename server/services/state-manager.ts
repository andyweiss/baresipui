import type { Account, Contact, ContactConfig, CallInfo, AudioMeter } from '~/types';

interface LogEntry {
  timestamp: number;
  type: string;
  message: string;
  data?: any;
}

export class StateManager {
  private accounts = new Map<string, Account>();
  private autoConnectConfig = new Map<string, ContactConfig>();
  private contactPresence = new Map<string, string>();
  private activeCalls = new Map<string, CallInfo>(); // Track all active calls
  private audioMeters = new Map<string, AudioMeter>(); // Track audio levels per account
  private wsClients = new Set<any>();
  private socketClients = new Set<any>(); // Socket.IO clients
  private sseStreams = new Set<any>(); // SSE streams
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // Maximum number of logs to keep
  private baresipConnected = false; // Track Baresip TCP connection status
  private baresipVersion: string | undefined = undefined;

  setBaresipVersion(version: string) {
    this.baresipVersion = version;
  }
  getBaresipVersion(): string | undefined {
    return this.baresipVersion;
  }

  getAccounts(): Account[] {
    // 1. Accounts kopieren (autoConnectContact bleibt wie gespeichert)
    const accounts = Array.from(this.accounts.values()).map(acc => ({ ...acc }));

    // 2. Stabile Sortierung: numerisch nach SIP-Nummer, dann lexikografisch nach URI
    function extractNumber(uri: string): number | null {
      if (!uri) return null;
      const match = uri.replace(/^sip:/, '').match(/(\d+)/);
      if (match) {
        const n = parseInt(match[1].replace(/^0+/, ''), 10);
        return isNaN(n) ? null : n;
      }
      return null;
    }
    accounts.sort((a, b) => {
      const nA = extractNumber(a.uri);
      const nB = extractNumber(b.uri);
      if (nA !== null && nB !== null) {
        if (nA !== nB) return nA - nB;
        return (a.uri || '').localeCompare(b.uri || '');
      } else if (nA !== null) {
        return -1;
      } else if (nB !== null) {
        return 1;
      }
      return (a.uri || '').localeCompare(b.uri || '');
    });
    console.log(`StateManager.getAccounts() called - returning ${accounts.length} accounts:`, accounts.map(a => a.uri));
    return accounts;
  }


  getAccount(uri: string): Account | undefined {
    if (!uri) return undefined;
    return this.accounts.get(String(uri).toLowerCase().trim());
  }


  hasAccount(uri: string): boolean {
    if (!uri) return false;
    return this.accounts.has(String(uri).toLowerCase().trim());
  }


  setAccount(uri: string, account: Account): void {
    if (!uri) return;
    this.accounts.set(String(uri).toLowerCase().trim(), account);
  }

  getContacts(): Contact[] {
    return Array.from(this.autoConnectConfig.entries()).map(([contact, config]) => ({
      contact,
      name: config.name || contact,
      enabled: config.enabled,
      status: config.status || 'Off',
      presence: this.contactPresence.get(contact) || 'unknown',
      assignedAccount: config.assignedAccount
    }));
  }

  setBaresipConnected(connected: boolean): void {
    if (this.baresipConnected !== connected) {
      this.baresipConnected = connected;
      console.log(`🔌 Baresip connection status changed: ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);
      this.broadcast({
        type: 'baresipStatus',
        data: { connected }
      });
    }
  }

  getBaresipConnected(): boolean {
    return this.baresipConnected;
  }

  getContactConfig(contact: string): ContactConfig | undefined {
    return this.autoConnectConfig.get(contact);
  }

  setContactConfig(contact: string, config: ContactConfig): void {
    this.autoConnectConfig.set(contact, config);
  }

  hasContactConfig(contact: string): boolean {
    return this.autoConnectConfig.has(contact);
  }

  getContactPresence(contact: string): string {
    return this.contactPresence.get(contact) || 'unknown';
  }

  setContactPresence(contact: string, presence: string): void {
    this.contactPresence.set(contact, presence);
  }


  updateAccountStatus(uri: string, updates: Partial<Account>): void {
    if (!uri) return;
    const normUri = String(uri).toLowerCase().trim();
    const current = this.accounts.get(normUri) || {
      uri: normUri,
      registered: false,
      callStatus: 'Idle' as const,
      autoConnectStatus: 'Off',
      lastEvent: Date.now(),
      configured: true
    };
    const updated = { ...current, ...updates, lastEvent: Date.now() };
    this.accounts.set(normUri, updated);
    console.log(`Account updated: ${normUri}`, updated);
    console.log(`Total accounts in state: ${this.accounts.size}`);
    console.log(`WebSocket clients connected: ${this.wsClients.size}`);
    this.broadcast({
      type: 'accountStatus',
      data: updated
    });
  }

  updateAutoConnectStatus(contact: string, status: string): void {
    const config = this.autoConnectConfig.get(contact) || {
      name: contact,
      enabled: false,
      status: 'Off'
    };
    config.status = status;
    this.autoConnectConfig.set(contact, config);

    this.broadcast({
      type: 'autoConnectStatus',
      contact,
      status
    });
  }

  addWsClient(client: any): void {
    this.wsClients.add(client);
  }

  removeWsClient(client: any): void {
    this.wsClients.delete(client);
  }

  addSocketClient(client: any): void {
    this.socketClients.add(client);
  }

  removeSocketClient(client: any): void {
    this.socketClients.delete(client);
  }

  broadcast(data: any): void {
    const message = JSON.stringify(data);
    
    console.log(`📢 Broadcasting to ${this.wsClients.size} WS clients and ${this.socketClients.size} Socket.IO clients:`, data.type);
    
    // Broadcast to WebSocket clients
    this.wsClients.forEach(client => {
      try {
        if (client.readyState === 1 || (client.send && typeof client.send === 'function')) {
          client.send(message);
        }
      } catch (error) {
        console.error('Error broadcasting to WS client:', error);
        this.wsClients.delete(client);
      }
    });

    // Broadcast to Socket.IO clients
    this.socketClients.forEach(client => {
      try {
        if (client.connected) {
          // Emit with specific event type for better handling
          if (data.type) {
            client.emit(data.type, data.data || data);
          }
          // Also emit as 'message' for backward compatibility
          client.emit('message', data);
        }
      } catch (error) {
        console.error('Error broadcasting to Socket.IO client:', error);
        this.socketClients.delete(client);
      }
    });
  }

  getInitData() {
    const accounts = this.getAccounts();
    console.log(`DEBUG: getInitData - returning ${accounts.length} accounts:`, accounts);
    return {
      type: 'init',
      accounts: accounts,
      contacts: this.getContacts(),
      baresipConnected: this.baresipConnected,
      calls: this.getCalls(),
      audioMeters: this.getAllAudioMeters()
    };
  }

  getContactsSize(): number {
    return this.autoConnectConfig.size;
  }

  getAccountsSize(): number {
    return this.accounts.size;
  }

  addLog(type: string, message: string, data?: any): void {
    // Extrahiere Version immer auf Top-Level, falls vorhanden
    let version: string | undefined = undefined;
    if (data && typeof data === 'object') {
      if (data.version) version = data.version;
      else if (data.data && data.data.version) version = data.data.version;
    }
    const logEntry: LogEntry = {
      timestamp: Date.now(),
      type,
      message,
      data,
      ...(version ? { version } : {})
    };
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    this.broadcast({
      type: 'log',
      log: logEntry
    });
  }

  getLogs(limit: number = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
  }

  // Call Management
  addCall(call: CallInfo): void {
    this.activeCalls.set(call.callId, call);
    console.log(`📞 Call added: ${call.callId} (${call.localUri} -> ${call.remoteUri})`);
    
    this.broadcast({
      type: 'callAdded',
      data: call
    });
  }

  updateCall(callId: string, updates: Partial<CallInfo>): void {
    const call = this.activeCalls.get(callId);
    if (call) {
      const updated = { ...call, ...updates };
      this.activeCalls.set(callId, updated);
      
      this.broadcast({
        type: 'callUpdated',
        data: updated
      });
    }
  }

  removeCall(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (call) {
      this.activeCalls.delete(callId);
      console.log(`📞 Call removed: ${callId}`);
      
      this.broadcast({
        type: 'callRemoved',
        data: { callId, call }
      });
    }
  }

  getCall(callId: string): CallInfo | undefined {
    return this.activeCalls.get(callId);
  }

  getCalls(): CallInfo[] {
    return Array.from(this.activeCalls.values());
  }

  getCallsByAccount(accountUri: string): CallInfo[] {
    return Array.from(this.activeCalls.values())
      .filter(call => call.localUri === accountUri);
  }

  // Audio Meter Management
  updateAudioMeter(meter: AudioMeter): void {
    this.audioMeters.set(meter.accountUri, meter);
    
    // Broadcast audio meters (throttled, only every 100ms per account)
    const now = Date.now();
    const lastUpdate = this.audioMeters.get(meter.accountUri)?.timestamp || 0;
    
    if (now - lastUpdate > 100) {
      this.broadcast({
        type: 'audioMeter',
        data: meter
      });
    }
  }

  getAudioMeter(accountUri: string): AudioMeter | undefined {
    return this.audioMeters.get(accountUri);
  }

  getAllAudioMeters(): AudioMeter[] {
    return Array.from(this.audioMeters.values());
  }
}

export const stateManager = new StateManager();
