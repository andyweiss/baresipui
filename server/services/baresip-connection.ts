import net from 'node:net';
import { createNetstring } from '../utils/netstring';
import { stateManager } from './state-manager';
import { parseBaresipEvent } from './baresip-parser';
import { getAutoConnectConfigManager } from './autoconnect-config';

export class BaresipConnection {
  private client: net.Socket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000;
  private contactsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CONTACTS_POLL_INTERVAL = 5000; // Poll contacts every 5 seconds

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

      this.sendCommand('ualist');
      this.sendCommand('reginfo');
      this.sendCommand('contacts');

      // Start polling contacts for presence updates
      this.startContactsPolling();

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
      this.stopContactsPolling();
      this.scheduleReconnect();
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
      }
    }, this.CONTACTS_POLL_INTERVAL);
  }

  private stopContactsPolling(): void {
    if (this.contactsPollingInterval) {
      console.log('Stopping contacts polling');
      clearInterval(this.contactsPollingInterval);
      this.contactsPollingInterval = null;
    }
  }

  private applySavedConfigs(): void {
    const configManager = getAutoConnectConfigManager();
    const allConfigs = configManager.getAllConfigs();
    
    console.log('Applying saved auto-connect configs...');
    
    for (const [accountUri, config] of Object.entries(allConfigs.accounts)) {
      const account = stateManager.getAccount(accountUri);
      if (account && config.autoConnectContact) {
        account.autoConnectContact = config.autoConnectContact;
        stateManager.setAccount(accountUri, account);
        console.log(`Applied config for ${accountUri}: contact=${config.autoConnectContact}, enabled=${config.enabled}`);
        
        // Broadcast account update
        stateManager.broadcast({
          type: 'accountStatus',
          data: account
        });
      }
    }
  }

  sendCommand(command: string, params?: string, token?: string): void {
    if (this.client && !this.client.destroyed) {
      // Erstelle JSON-Nachricht für Baresip (exakt wie im alten Backend)
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
