import { spawn, type ChildProcess } from 'child_process';
import type { StateManager } from './state-manager';

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  accountUri?: string;
}

export class BaresipLogger {
  private logProcess: ChildProcess | null = null;
  private stateManager: StateManager;
  private logBuffer: LogEntry[] = [];
  private maxBufferSize = 1000;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  start(containerName: string = 'baresip'): void {
    console.log(`📝 Starting baresip log streaming from container: ${containerName}`);

    // Stream Docker container logs
    this.logProcess = spawn('docker', ['logs', '-f', '--tail', '100', containerName]);

    if (this.logProcess.stdout) {
      this.logProcess.stdout.on('data', (data: Buffer) => {
        this.processLogData(data.toString(), 'stdout');
      });
    }

    if (this.logProcess.stderr) {
      this.logProcess.stderr.on('data', (data: Buffer) => {
        this.processLogData(data.toString(), 'stderr');
      });
    }

    this.logProcess.on('error', (error) => {
      console.error('❌ Log process error:', error);
    });

    this.logProcess.on('exit', (code) => {
      console.log(`📝 Log process exited with code ${code}`);
      // Auto-restart after 5 seconds
      setTimeout(() => this.start(containerName), 5000);
    });
  }

  stop(): void {
    if (this.logProcess) {
      this.logProcess.kill();
      this.logProcess = null;
    }
  }

  private processLogData(data: string, stream: 'stdout' | 'stderr'): void {
    const lines = data.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const entry = this.parseLogLine(line, stream);
      
      // Add to buffer
      this.logBuffer.push(entry);
      if (this.logBuffer.length > this.maxBufferSize) {
        this.logBuffer.shift(); // Remove oldest entry
      }

      // Broadcast to clients
      this.stateManager.broadcast({
        type: 'log',
        data: entry
      });

      // Also log to console for debugging
      const emoji = this.getLevelEmoji(entry.level);
      console.log(`${emoji} [${entry.source}] ${entry.message}`);
    }
  }

  private parseLogLine(line: string, stream: 'stdout' | 'stderr'): LogEntry {
    const timestamp = Date.now();
    
    // Try to extract log level from common patterns
    let level: LogEntry['level'] = stream === 'stderr' ? 'error' : 'info';
    let source = 'baresip';
    let message = line;
    let accountUri: string | undefined;

    // Pattern: "module: message"
    const moduleMatch = line.match(/^([a-z_]+):\s+(.+)$/i);
    if (moduleMatch) {
      source = moduleMatch[1];
      message = moduleMatch[2];
    }

    // Pattern: "DEBUG: message" or "INFO: message"
    const levelMatch = line.match(/^(DEBUG|INFO|WARN|ERROR|WARNING):\s+(.+)$/i);
    if (levelMatch) {
      const levelStr = levelMatch[1].toLowerCase();
      level = levelStr === 'warning' ? 'warn' : levelStr as LogEntry['level'];
      message = levelMatch[2];
    }

    // Pattern: "<account@domain> message"
    const accountMatch = message.match(/<([^>]+@[^>]+)>/);
    if (accountMatch) {
      accountUri = accountMatch[1];
    }

    // Detect error patterns
    if (message.toLowerCase().includes('error') || 
        message.toLowerCase().includes('failed') ||
        message.toLowerCase().includes('cannot')) {
      level = 'error';
    } else if (message.toLowerCase().includes('warning') || 
               message.toLowerCase().includes('warn')) {
      level = 'warn';
    } else if (message.toLowerCase().includes('debug')) {
      level = 'debug';
    }

    return {
      timestamp,
      level,
      source,
      message: message.trim(),
      accountUri
    };
  }

  private getLevelEmoji(level: LogEntry['level']): string {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
      default: return '📝';
    }
  }

  getLogs(limit?: number): LogEntry[] {
    if (limit) {
      return this.logBuffer.slice(-limit);
    }
    return [...this.logBuffer];
  }

  getLogsByAccount(accountUri: string, limit?: number): LogEntry[] {
    const filtered = this.logBuffer.filter(log => log.accountUri === accountUri);
    if (limit) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  getLogsByLevel(level: LogEntry['level'], limit?: number): LogEntry[] {
    const filtered = this.logBuffer.filter(log => log.level === level);
    if (limit) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  clearLogs(): void {
    this.logBuffer = [];
    this.stateManager.broadcast({
      type: 'logsCleared',
      data: {}
    });
  }
}
