import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createNetstring } from '../utils/netstring';
import { stateManager } from './state-manager';
import {
  parseBaresipEventBuffered,
  registerBaresipResponseObserver,
} from './baresip-parser';
import { getAutoConnectConfigManager } from './autoconnect-config';
import { getBaresipLogger } from '../utils/logger';
import type { BaresipCommandResponse } from '~/types';

export interface ExecuteCommandOptions {
  timeoutMs?: number;
  token?: string;
}

export interface BaresipSequenceCommand {
  command: string;
  params?: string;
  token?: string;
}

export class BaresipCommandError extends Error {
  constructor(
    message: string,
    readonly response?: BaresipCommandResponse,
  ) {
    super(message);
    this.name = 'BaresipCommandError';
  }
}

interface PendingCommand {
  command: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: BaresipCommandResponse) => void;
  reject: (error: Error) => void;
}

export type BaresipConnectionStatusListener = (connected: boolean) => void;

export class BaresipConnection {
  private client: net.Socket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000;
  private contactsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CONTACTS_POLL_INTERVAL = 10000; // Poll contacts/presence every 10 seconds
  private callStatsPollingInterval: NodeJS.Timeout | null = null;
  private readonly CALL_STATS_POLL_INTERVAL = 3000; // Poll RTCP stats every 3 seconds
  private tcpBuffer = ''; // Persistent buffer for fragmented TCP netstrings
  private commandSequenceLock: Promise<void> = Promise.resolve();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly statusListeners = new Set<BaresipConnectionStatusListener>();
  private connected = false;

  constructor(
    private host: string,
    private port: number
  ) {
    registerBaresipResponseObserver((response) => {
      this.handleCorrelatedResponse(response);
    });
  }

  async connect(): Promise<void> {
    if (this.client) {
      this.setConnected(false);
      this.rejectPendingCommands(
        new BaresipCommandError('Baresip connection was replaced before command response'),
      );
      this.client.removeAllListeners(); // Prevent old close handler from triggering zombie reconnect
      this.client.destroy();
      this.client = null;
    }

    // Load auto-connect config before connecting
    const configManager = getAutoConnectConfigManager();
    await configManager.load();

    this.client = new net.Socket();

    this.client.connect(this.port, this.host, () => {
      this.reconnectAttempts = 0;
      this.setConnected(true);
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
      this.setConnected(false);
      stateManager.setBaresipConnected(false);
      this.rejectPendingCommands(
        new BaresipCommandError('Baresip disconnected before command response'),
      );
      
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

  private stopContactsPolling(): void {
    if (this.contactsPollingInterval) {
      clearInterval(this.contactsPollingInterval);
      this.contactsPollingInterval = null;
    }
  }

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
  sendCommandSequence(commands: BaresipSequenceCommand[]): void {
    const operation = this.commandSequenceLock.then(async () => {
      for (const cmd of commands) {
        this.sendCommand(cmd.command, cmd.params, cmd.token);
      }
      // Small yield to ensure TCP write is flushed before releasing lock
      await new Promise(r => setTimeout(r, 10));
    });
    this.commandSequenceLock = operation.catch(() => undefined);
  }

  /**
   * Executes and correlates each command under the same global sequence lock.
   * A failed selection command rejects immediately, so later commands (for
   * example a DTMF digit after callfind) are never sent to the wrong call.
   */
  executeCommandSequence(
    commands: BaresipSequenceCommand[],
    options: Omit<ExecuteCommandOptions, 'token'> = {},
  ): Promise<BaresipCommandResponse[]> {
    const operation = this.commandSequenceLock.then(async () => {
      const responses: BaresipCommandResponse[] = [];
      for (const command of commands) {
        const response = await this.executeCommand(
          command.command,
          command.params,
          {
            ...options,
            ...(command.token ? { token: command.token } : {}),
          },
        );
        if (responseTextIndicatesError(response)) {
          throw new BaresipCommandError(
            `Baresip command "${command.command}" failed: ${String(
              response.data,
            ).trim()}`,
            response,
          );
        }
        responses.push(response);
      }
      return responses;
    });
    this.commandSequenceLock = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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
    for (const [accountUri, config] of Object.entries(allConfigs.accounts)) {
      let account = stateManager.getAccount(accountUri);
      if (!account) {
        configManager.removeAccount(accountUri).catch(() => {});
        continue;
      }
      if (config.autoConnectContact) {
        account.autoConnectContact = config.autoConnectContact;
      }
      stateManager.setAccount(accountUri, account);
      // Broadcast account update
      stateManager.broadcast({
        type: 'accountStatus',
        data: account
      });
    }
    // After applying all configs: broadcast initial data
    stateManager.broadcast(stateManager.getInitData());
  }

  sendCommand(command: string, params?: string, token?: string): boolean {
    if (this.isConnected() && this.client) {
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
      return true;
    }
    return false;
  }

  executeCommand(
    command: string,
    params?: string,
    options: ExecuteCommandOptions = {},
  ): Promise<BaresipCommandResponse> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      return Promise.reject(
        new Error('Baresip command timeout must be between 1 and 120000 ms'),
      );
    }
    if (!this.isConnected()) {
      return Promise.reject(new BaresipCommandError('Baresip is not connected'));
    }

    const token = options.token?.trim() || `baresipui-${randomUUID()}`;
    if (!token || /[\s\r\n\0]/.test(token)) {
      return Promise.reject(new Error('Baresip command token is invalid'));
    }
    if (this.pendingCommands.has(token)) {
      return Promise.reject(new Error(`Baresip command token is already pending: ${token}`));
    }

    return new Promise<BaresipCommandResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(token);
        reject(
          new BaresipCommandError(
            `Baresip command "${command}" timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
      this.pendingCommands.set(token, { command, timeout, resolve, reject });

      try {
        if (!this.sendCommand(command, params, token)) {
          clearTimeout(timeout);
          this.pendingCommands.delete(token);
          reject(new BaresipCommandError('Baresip disconnected before command write'));
        }
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCommands.delete(token);
        reject(
          error instanceof Error
            ? error
            : new BaresipCommandError('Baresip command write failed'),
        );
      }
    });
  }

  onConnectionStatusChange(listener: BaresipConnectionStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private handleCorrelatedResponse(response: BaresipCommandResponse): void {
    if (!response.token) return;
    const pending = this.pendingCommands.get(response.token);
    if (!pending) return;
    this.pendingCommands.delete(response.token);
    clearTimeout(pending.timeout);
    if (!response.ok) {
      const detail =
        typeof response.data === 'string' && response.data.trim()
          ? `: ${response.data.trim()}`
          : '';
      pending.reject(
        new BaresipCommandError(
          `Baresip command "${pending.command}" failed${detail}`,
          response,
        ),
      );
      return;
    }
    pending.resolve(response);
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.statusListeners) {
      try {
        listener(connected);
      } catch (error) {
        console.error('Baresip connection status listener failed:', error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnect attempts reached');
      return;
    }

    const delay = this.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  isConnected(): boolean {
    return this.client !== null &&
      !this.client.destroyed &&
      this.client.writable &&
      this.client.readyState === 'open';
  }
}

let baresipConnection: BaresipConnection | null = null;

export function getBaresipConnection(host: string, port: number): BaresipConnection {
  if (!baresipConnection) {
    baresipConnection = new BaresipConnection(host, port);
  }
  return baresipConnection;
}

function responseTextIndicatesError(
  response: BaresipCommandResponse,
): boolean {
  if (typeof response.data !== 'string') return false;
  const text = response.data.trim();
  return (
    /\bERROR\b/.test(text) ||
    /(?:^|\n)\s*(?:error|failed|invalid)\b/i.test(text) ||
    /\b(?:call|account)\s+not\s+found\b/i.test(text) ||
    /\bno\s+(?:active\s+)?call\b/i.test(text)
  );
}
