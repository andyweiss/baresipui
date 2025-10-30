import net from 'node:net';
import { createNetstring } from '../utils/netstring';
import { stateManager } from './state-manager';
import { parseBaresipEvent } from './baresip-parser';

export class BaresipConnection {
  private client: net.Socket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000;

  constructor(
    private host: string,
    private port: number
  ) {}

  connect(): void {
    if (this.client) {
      this.client.destroy();
    }

    this.client = new net.Socket();

    this.client.connect(this.port, this.host, () => {
      console.log(`Connected to Baresip at ${this.host}:${this.port}`);
      this.reconnectAttempts = 0;

      this.sendCommand('ualist');
      this.sendCommand('reginfo');
      this.sendCommand('contacts');

      setTimeout(() => {
        console.log(`Accounts loaded via API: ${stateManager.getAccountsSize()}`);
        console.log(`Contacts loaded via API: ${stateManager.getContactsSize()}`);
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
      this.scheduleReconnect();
    });
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
