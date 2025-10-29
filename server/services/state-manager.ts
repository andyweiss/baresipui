import type { Account, Contact, ContactConfig } from '~/types';

export class StateManager {
  private accounts = new Map<string, Account>();
  private autoConnectConfig = new Map<string, ContactConfig>();
  private contactPresence = new Map<string, string>();
  private wsClients = new Set<any>();

  getAccounts(): Account[] {
    return Array.from(this.accounts.values());
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
      presence: this.contactPresence.get(contact) || 'unknown'
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
      configured: false
    };

    const updated = { ...current, ...updates, lastEvent: Date.now() };
    this.accounts.set(uri, updated);

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

  broadcast(data: any): void {
    const message = JSON.stringify(data);
    this.wsClients.forEach(client => {
      try {
        if (client.readyState === 1 || (client.send && typeof client.send === 'function')) {
          client.send(message);
        }
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        this.wsClients.delete(client);
      }
    });
  }

  getInitData() {
    return {
      type: 'init',
      accounts: this.getAccounts(),
      contacts: this.getContacts()
    };
  }

  getContactsSize(): number {
    return this.autoConnectConfig.size;
  }

  getAccountsSize(): number {
    return this.accounts.size;
  }
}

export const stateManager = new StateManager();
