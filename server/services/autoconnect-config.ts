import fs from 'fs/promises';
import path from 'path';

interface AutoConnectConfig {
  accounts: {
    [accountUri: string]: {
      autoConnectContact: string;
      enabled: boolean;
    };
  };
}

export class AutoConnectConfigManager {
  private configPath: string;
  private config: AutoConnectConfig = { accounts: {} };

  constructor(configPath: string = '/config/autoconnect.json') {
    this.configPath = configPath;
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data);
      console.log(`Loaded auto-connect config from ${this.configPath}:`, this.config);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        console.log(`Auto-connect config file not found, creating new one at ${this.configPath}`);
        this.config = { accounts: {} };
        await this.save();
      } else {
        console.error(`Failed to load auto-connect config:`, err);
        this.config = { accounts: {} };
      }
    }
  }

  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      console.log(`Saved auto-connect config to ${this.configPath}`);
    } catch (err) {
      console.error(`Failed to save auto-connect config:`, err);
    }
  }

  getContactConfig(accountUri: string): { autoConnectContact?: string; enabled: boolean } {
    return this.config.accounts[accountUri] || { enabled: false };
  }

  async setContactAccount(accountUri: string, contactUri: string): Promise<void> {
    if (!contactUri || contactUri === '') {
      // Remove or clear auto-connect
      if (this.config.accounts[accountUri]) {
        delete this.config.accounts[accountUri].autoConnectContact;
      }
    } else {
      // Set auto-connect contact
      if (!this.config.accounts[accountUri]) {
        this.config.accounts[accountUri] = { autoConnectContact: contactUri, enabled: false };
      } else {
        this.config.accounts[accountUri].autoConnectContact = contactUri;
      }
    }
    await this.save();
  }

  async setContactEnabled(accountUri: string, enabled: boolean): Promise<void> {
    if (!this.config.accounts[accountUri]) {
      this.config.accounts[accountUri] = { autoConnectContact: '', enabled };
    } else {
      this.config.accounts[accountUri].enabled = enabled;
    }
    await this.save();
  }

  getAllConfigs(): AutoConnectConfig {
    return this.config;
  }
}

// Singleton instance
let autoConnectConfigManager: AutoConnectConfigManager | null = null;

export function getAutoConnectConfigManager(): AutoConnectConfigManager {
  if (!autoConnectConfigManager) {
    autoConnectConfigManager = new AutoConnectConfigManager();
  }
  return autoConnectConfigManager;
}
