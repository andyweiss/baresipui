import type { Account, Contact, ContactConfig, CallInfo, AudioMeter, LogEntry } from '~/types';

export class StateManager {
  private accounts = new Map<string, Account>();
  private autoConnectConfig = new Map<string, ContactConfig>();
  private contactPresence = new Map<string, string>();
  private contactLastSeen = new Map<string, number>(); // Track last seen timestamp
  private contactCallFailureTimestamp = new Map<string, number>(); // Timestamp when auto-connect call failed
  private activeCalls = new Map<string, CallInfo>(); // Track all active calls
  private audioMeters = new Map<string, AudioMeter>(); // Track audio levels per account
  private socketClients = new Set<any>();
  private io: any = null; // Socket.IO server instance for room-based broadcasting
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private logBatchBuffer: LogEntry[] = [];
  private logBatchTimer: any = null;
  private readonly LOG_BATCH_INTERVAL = 500; // Batch log broadcasts every 500ms
  private baresipConnected = false; // Track Baresip TCP connection status
  private baresipInfo: { version?: string; uptime?: string; started?: string } = {};
  // contacts API: loads contact names only
  // presence_ts: ONLY source for presence status (checks timestamp age)

  constructor() {}

  setBaresipInfo(info: { version?: string; uptime?: string; started?: string }) {
    // Replace old info completely instead of merging to avoid stale data
    this.baresipInfo = info;
    this.broadcast({
      type: 'baresipInfo',
      data: this.baresipInfo
    });
  }

  getBaresipInfo() {
    return this.baresipInfo;
  }

  getAccounts(): Account[] {
    // 1. Clone accounts (autoConnectContact stays as stored)
    const accounts = Array.from(this.accounts.values()).map(acc => ({ ...acc }));

    // 2. Stable sort: numeric by SIP number, then lexicographic by URI
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
      assignedAccount: config.assignedAccount,
      lastSeen: this.contactLastSeen.get(contact)
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
      if (!connected) {
        // Also send dedicated disconnect event
        this.broadcast({
          type: 'baresipDisconnected'
        });
      }
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

  setContactPresence(contact: string, presence: string, updateLastSeen: boolean = false): void {
    this.contactPresence.set(contact, presence);
    
    // Update lastSeen timestamp only if requested
    if (updateLastSeen && presence !== 'unknown') {
      this.contactLastSeen.set(contact, Date.now());
    }
  }

  // Set presence after call failure and block old presence updates
  setContactCallFailureTimestamp(contact: string, presence: string): void {
    const now = Date.now();
    this.contactPresence.set(contact, presence);
    this.contactCallFailureTimestamp.set(contact, now);
    // Clear lastSeen to prevent presence_ts from overwriting with old status after auto-clear
    this.contactLastSeen.delete(contact);
  }

  // Check if call failure timestamp blocks old presence updates
  // Blocks old NOTIFYs (before the failure), but new NOTIFYs are always accepted
  // Auto-clears after 10 minutes to match presence timeout
  hasContactCallFailureTimestamp(contact: string, baresipTimestamp: number): boolean {
    const failureTime = this.contactCallFailureTimestamp.get(contact);
    if (!failureTime) return false;
    
    // Auto-clear after 10 minutes (600s) - match PRESENCE_TIMEOUT_SEC
    const ageSeconds = (Date.now() - failureTime) / 1000;
    if (ageSeconds > 600) {
      this.contactCallFailureTimestamp.delete(contact);
      return false;
    }
    
    // If baresip has NO timestamp, failure protection stays active
    if (!baresipTimestamp || baresipTimestamp === 0) {
      return true;
    }
    
    // If baresip timestamp is NEWER than failure (fresh NOTIFY received), clear protection
    const baresipTimestampMs = baresipTimestamp * 1000;
    if (baresipTimestampMs > failureTime) {
      this.contactCallFailureTimestamp.delete(contact);
      return false;
    }
    
    // NOTIFY is older than failure → block it, keep offline status
    return true;
  }

  // Clear call failure timestamp (e.g., when receiving new online PRESENCE_EVENT)
  clearContactCallFailureTimestamp(contact: string): void {
    this.contactCallFailureTimestamp.delete(contact);
  }

  // Set lastSeen timestamp directly (from presence_ts command)
  setContactLastSeen(contact: string, timestamp: number): void {
    this.contactLastSeen.set(contact, timestamp);
  }


  updateAccountStatus(uri: string, updates: Partial<Account>): void {
    if (!uri) return;
    const normUri = String(uri).toLowerCase().trim();
    const current = this.accounts.get(normUri) || {
      uri: normUri,
      registered: false,
      callStatus: 'Idle',
      autoConnectStatus: 'Off',
      lastEvent: Date.now(),
      configured: true
    };
    const updated = { ...current, ...updates, lastEvent: Date.now() };
    this.accounts.set(normUri, updated);
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

  setIO(ioServer: any): void {
    this.io = ioServer;
  }

  addSocketClient(client: any): void {
    this.socketClients.add(client);
  }

  removeSocketClient(client: any): void {
    this.socketClients.delete(client);
  }

  broadcast(data: any): void {
    // Skip log events in broadcast — logs are sent only to 'logs' room subscribers
    if (data.type === 'log' || data.type === 'logBatch') return;

    // Only truly disposable events use volatile emit (dropped if socket buffer full)
    const volatileTypes = ['audioMeter'];
    const isVolatile = volatileTypes.includes(data.type);

    this.socketClients.forEach(client => {
      try {
        if (client.connected) {
          const emitter = isVolatile ? client.volatile : client;
          if (data.type) {
            const payload = data.data || data;
            emitter.emit(data.type, payload);
          } else {
            emitter.emit('message', data);
          }
        }
      } catch (error) {
        console.error('Error broadcasting to Socket.IO client:', error);
        this.socketClients.delete(client);
      }
    });
  }

  getInitData() {
    const accounts = this.getAccounts();
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

  addLog(level: LogEntry['level'], source: string, message: string, accountUri?: string, data?: any): void {
    const logEntry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      accountUri,
      data
    };
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    // Batch logs and send only to 'logs' room subscribers
    this.logBatchBuffer.push(logEntry);
    if (!this.logBatchTimer) {
      this.logBatchTimer = setTimeout(() => {
        this.flushLogBatch();
      }, this.LOG_BATCH_INTERVAL);
    }
  }

  private flushLogBatch(): void {
    this.logBatchTimer = null;
    if (this.logBatchBuffer.length === 0) return;
    const entries = this.logBatchBuffer;
    this.logBatchBuffer = [];
    // Send only to clients in the 'logs' room
    if (this.io) {
      this.io.to('logs').emit('logBatch', { logs: entries });
    }
  }

  getLogs(limit: number = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
    // Notify log subscribers
    if (this.io) {
      this.io.to('logs').emit('logsCleared');
    }
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

  clearCalls(): void {
    this.activeCalls.clear();
    this.broadcast({
      type: 'callsCleared'
    });
  }

  setAllCallStatus(status: string): void {
    for (const [uri, account] of this.accounts.entries()) {
      const updated = { ...account, callStatus: status, callId: undefined };
      this.accounts.set(uri, updated);
    }
    this.broadcast({
      type: 'accountsUpdate',
      accounts: this.getAccounts()
    });
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
