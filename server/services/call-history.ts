import fs from 'fs/promises';
import path from 'path';

export interface CallHistoryEntry {
  uri: string;           // full SIP URI
  displayName?: string;  // resolved display name
  direction: 'incoming' | 'outgoing';
  count: number;         // how many times this URI was called
  lastCall: number;      // timestamp of last call (ms)
}

interface CallHistoryStore {
  accounts: {
    [accountUri: string]: CallHistoryEntry[];
  };
}

const MAX_ENTRIES = 10;

export class CallHistoryManager {
  private configPath: string;
  private store: CallHistoryStore = { accounts: {} };

  constructor(configPath: string = '/config/call-history.json') {
    this.configPath = configPath;
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.store = JSON.parse(data);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.store = { accounts: {} };
        await this.save();
      } else {
        console.error('Failed to load call history:', err);
        this.store = { accounts: {} };
      }
    }
  }

  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save call history:', err);
    }
  }

  getHistory(accountUri: string): CallHistoryEntry[] {
    return this.store.accounts[accountUri] || [];
  }

  async addEntry(accountUri: string, remoteUri: string, direction: 'incoming' | 'outgoing', displayName?: string): Promise<void> {
    if (!this.store.accounts[accountUri]) {
      this.store.accounts[accountUri] = [];
    }

    const list = this.store.accounts[accountUri];
    const existing = list.find(e => e.uri === remoteUri);

    if (existing) {
      existing.count += 1;
      existing.lastCall = Date.now();
      if (displayName) existing.displayName = displayName;
      // Move to front (most recent)
      list.splice(list.indexOf(existing), 1);
      list.unshift(existing);
    } else {
      list.unshift({
        uri: remoteUri,
        displayName,
        direction,
        count: 1,
        lastCall: Date.now(),
      });
    }

    // Keep only last MAX_ENTRIES unique entries
    this.store.accounts[accountUri] = list.slice(0, MAX_ENTRIES);

    await this.save();
  }
}

// Singleton
let instance: CallHistoryManager | null = null;

export function getCallHistoryManager(): CallHistoryManager {
  if (!instance) {
    instance = new CallHistoryManager();
  }
  return instance;
}
