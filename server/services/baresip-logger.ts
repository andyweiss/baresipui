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
  private pendingLogLine = ''; // Buffer for multi-line logs
  private flushTimer: NodeJS.Timeout | null = null; // Timer for flushing pending logs

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  start(containerName: string = 'baresip'): void {
    try {
      this.logProcess = spawn('docker', ['logs', '-f', '--tail', '100', containerName], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.logProcess.stdout?.on('data', (data: Buffer) => {
        this.processLogData(data.toString(), 'stdout');
      });

      this.logProcess.stderr?.on('data', (data: Buffer) => {
        this.processLogData(data.toString(), 'stderr');
      });

      this.logProcess.on('error', (err) => {
        console.error('❌ Docker logs process error:', err.message);
        this.addLog('error', 'system', `Failed to read container logs: ${err.message}`);
      });

      this.logProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          this.addLog('warn', 'system', `Container logs stream closed with code ${code}`);
        }
      });

      this.addLog('info', 'system', `Started monitoring container logs: ${containerName}`);
    } catch (err: any) {
      console.error('❌ Failed to start docker logs:', err.message);
      this.addLog('error', 'system', `Failed to start container logger: ${err.message}`);
    }
  }

  stop(): void {
    // Cancel flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Process any pending log line before stopping
    if (this.pendingLogLine && this.logProcess) {
      this.processLogEntry(this.pendingLogLine.trim(), 'stdout');
      this.pendingLogLine = '';
    }
    
    if (this.logProcess) {
      this.logProcess.kill();
      this.logProcess = null;
    }
  }

  private processLogData(data: string, stream: 'stdout' | 'stderr'): void {
    const lines = data.split('\n');
    
    // Cancel any pending flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    for (const line of lines) {
      if (!line.trim()) {
        // Empty line might indicate end of a multi-line log
        if (this.pendingLogLine) {
          this.pendingLogLine += '\n';
        }
        continue;
      }
      
      // Skip JSON event messages (they are handled by baresip-parser)
      if (line.trim().startsWith('{') && line.trim().includes('"event":true')) {
        continue;
      }
      
      // Check if this is a new log entry start
      // Baresip modules typically start with: "module: message" (e.g., "uag: ", "call: ", "reg: ")
      // Or timestamp patterns like "15:47:35.456#" or "[timestamp]"
      // SIP headers (Contact:, Max-Forwards:, etc.) are NOT new entries
      const isNewEntry = this.isNewLogEntry(line);
      
      if (isNewEntry && this.pendingLogLine) {
        // Process the previous pending log before starting new one
        this.processLogEntry(this.pendingLogLine.trim(), stream);
        this.pendingLogLine = line;
      } else if (isNewEntry) {
        // Start new log
        this.pendingLogLine = line;
      } else {
        // Append to pending log (continuation line)
        if (this.pendingLogLine) {
          this.pendingLogLine += '\n' + line;
        } else {
          // If no pending line, this might be orphaned - start new
          this.pendingLogLine = line;
        }
      }
    }
    
    // Set timer to flush pending log after 100ms of inactivity
    this.flushTimer = setTimeout(() => {
      if (this.pendingLogLine) {
        this.processLogEntry(this.pendingLogLine.trim(), stream);
        this.pendingLogLine = '';
      }
    }, 100);
  }
  
  private isNewLogEntry(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    
    // Baresip module patterns: lowercase_word:
    if (/^[a-z_]+:\s+/i.test(trimmed)) {
      // But exclude common SIP headers that also match this pattern
      const sipHeaders = ['contact:', 'from:', 'to:', 'via:', 'call-id:', 'cseq:', 'content-length:', 
                          'content-type:', 'authorization:', 'user-agent:', 'max-forwards:', 'allow:',
                          'expires:', 'route:', 'record-route:', 'supported:', 'require:'];
      const lowerLine = trimmed.toLowerCase();
      const isSipHeader = sipHeaders.some(header => lowerLine.startsWith(header));
      if (!isSipHeader) {
        return true; // It's a baresip module log
      }
    }
    
    // Log level patterns: DEBUG:, INFO:, WARN:, ERROR:
    if (/^(DEBUG|INFO|WARN|ERROR|WARNING):\s+/i.test(trimmed)) {
      return true;
    }
    
    // Timestamp patterns: "15:47:35.456#" or "[HH:MM:SS]"
    if (/^\d{1,2}:\d{2}:\d{2}[.#]/.test(trimmed) || /^\[\d{2}:\d{2}:\d{2}\]/.test(trimmed)) {
      return true;
    }
    
    // UDP/TCP protocol lines
    if (/^(UDP|TCP)\s+\d+\.\d+\.\d+\.\d+/.test(trimmed)) {
      return true;
    }
    
    // SIP request/response lines
    if (/^(REGISTER|INVITE|BYE|ACK|CANCEL|OPTIONS|NOTIFY|INFO|MESSAGE|UPDATE|SUBSCRIBE|REFER)\s+sip:/.test(trimmed) ||
        /^SIP\/2\.0\s+\d{3}/.test(trimmed)) {
      return true;
    }
    
    return false;
  }
  
  private processLogEntry(line: string, stream: 'stdout' | 'stderr'): void {
    // Remove ANSI escape codes (color codes, cursor positioning, etc.)
    line = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[\d+G/g, '');
    
    // Skip empty or very short lines
    if (!line.trim() || line.trim().length < 3) {
      return;
    }
    
    // Skip JSON event messages (they are handled by baresip-parser)
    if (line.trim().startsWith('{') && line.trim().includes('"event":true')) {
      return;
    }
    
    // Filter out audio bitrate statistics
    if (line.match(/\[\d+:\d+:\d+\]\s+audio=/i) || 
        line.match(/audio=\d+\/\d+\s*\(bit\/s\)/i)) {
      return;
    }
    
    // Skip rtcpstats_periodic (handled via TCP socket)
    if (line.includes('rtcpstats_periodic:') && line.includes('call_id=')) {
      return;
    }
    
    const entry = this.parseLogLine(line, stream);
    
    // Skip entries with empty messages
    if (!entry.message || entry.message.length < 2) {
      return;
    }
    
    // Add to buffer (no broadcast — logs are sent only to 'logs' room subscribers)
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
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
  }

  /**
   * Manually add a log entry (for internal debug messages, TCP events, etc.)
   */
  addLog(level: LogEntry['level'], source: string, message: string, accountUri?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      accountUri
    };

    // Add to buffer (no broadcast — logs are sent only to 'logs' room subscribers)
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }
}
