import type { Account, Contact, ContactConfig } from '~/types';

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
  private wsClients = new Set<any>();
  private socketClients = new Set<any>(); // Socket.IO clients
  private sseStreams = new Set<any>(); // SSE streams
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // Maximum number of logs to keep

  getAccounts(): Account[] {
    const accounts = Array.from(this.accounts.values());
    console.log(`StateManager.getAccounts() called - returning ${accounts.length} accounts:`, accounts.map(a => a.uri));
    return accounts;
  }

  getAccount(uri: string): Account | undefined {
    return this.accounts.get(uri);
  }

  hasAccount(uri: string): boolean {
    return this.accounts.has(uri);
  }

  setAccount(uri: string, account: Account): void {
    this.accounts.set(uri, account);
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
    const current = this.accounts.get(uri) || {
      uri,
      registered: false,
      callStatus: 'Idle' as const,
      autoConnectStatus: 'Off',
      lastEvent: Date.now(),
      configured: true  // Wenn baresip Events für diesen Account sendet, ist er konfiguriert
    };

    const updated = { ...current, ...updates, lastEvent: Date.now() };
    this.accounts.set(uri, updated);
    
    console.log(`Account updated: ${uri}`, updated);
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
      contacts: this.getContacts()
    };
  }

  getContactsSize(): number {
    return this.autoConnectConfig.size;
  }

  getAccountsSize(): number {
    return this.accounts.size;
  }

  addLog(type: string, message: string, data?: any): void {
    const logEntry: LogEntry = {
      timestamp: Date.now(),
      type,
      message,
      data
    };
    
    this.logs.push(logEntry);
    
    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Broadcast log to WebSocket clients
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
}

export const stateManager = new StateManager();
