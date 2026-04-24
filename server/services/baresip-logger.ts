import { spawn, type ChildProcess } from 'child_process';
import { stat, rename, unlink } from 'fs/promises';
import type { StateManager } from './state-manager';
import type { LogEntry } from '~/types';

// Re-export LogEntry so existing imports still work
export type { LogEntry };

const LOG_FILE = process.env.BARESIP_LOG_FILE || '/shared-logs/baresip.log';
const LOG_MAX_SIZE = 100 * 1024 * 1024; // 100 MB
const LOG_MAX_FILES = 5;
const LOG_ROTATION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class BaresipLogger {
  private logProcess: ChildProcess | null = null;
  private stateManager: StateManager;
  private logBuffer: LogEntry[] = [];
  private maxBufferSize = 1000;
  private pendingLogLine = ''; // Buffer for multi-line logs
  private flushTimer: NodeJS.Timeout | null = null; // Timer for flushing pending logs
  private rotationTimer: NodeJS.Timeout | null = null;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  start(): void {
    try {
      // Read baresip container logs from shared volume file using tail -F
      // -F follows by name (handles rotation/truncate), -n 100 shows last 100 lines
      this.logProcess = spawn('tail', ['-F', '-n', '100', LOG_FILE], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.logProcess.stdout?.on('data', (data: Buffer) => {
        this.processLogData(data.toString(), 'stdout');
      });

      // tail -F outputs file-tracking messages on stderr (e.g. "file truncated")
      this.logProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('file truncated') && !msg.includes('has appeared')) {
          console.error('tail stderr:', msg);
        }
      });

      this.logProcess.on('error', (err) => {
        console.error('Log reader process error:', err.message);
        this.addAndBroadcast('error', 'system', `Failed to read log file: ${err.message}`);
      });

      this.logProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          this.addAndBroadcast('warn', 'system', `Log reader closed with code ${code}`);
        }
      });

      this.addAndBroadcast('info', 'system', `Started monitoring log file: ${LOG_FILE}`);

      // Start periodic log rotation check
      this.rotationTimer = setInterval(() => {
        this.rotateIfNeeded().catch(err => {
          console.error('Log rotation error:', err.message);
        });
      }, LOG_ROTATION_CHECK_INTERVAL);

    } catch (err: any) {
      console.error('Failed to start log reader:', err.message);
      this.addAndBroadcast('error', 'system', `Failed to start log reader: ${err.message}`);
    }
  }

  stop(): void {
    // Cancel flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Cancel rotation timer
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
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
    
    // Store in local buffer for historical retrieval
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // Broadcast live via stateManager (sends to 'logs' room subscribers)
    this.stateManager.addLog(entry.level, entry.source, entry.message, entry.accountUri);
  }

  private parseLogLine(line: string, stream: 'stdout' | 'stderr'): LogEntry {
    const timestamp = Date.now();
    
    // Try to extract log level from common patterns
    let level: LogEntry['level'] = stream === 'stderr' ? 'error' : 'info';
    let source = 'baresip';
    let message = line;
    let accountUri: string | undefined;

    // Pattern: "module: message"
    const moduleMatch = line.match(/^([a-z_]+):\s+(.+)$/is);
    if (moduleMatch) {
      source = moduleMatch[1];
      message = moduleMatch[2];
    }

    // Pattern: "DEBUG: message" or "INFO: message"
    const levelMatch = line.match(/^(DEBUG|INFO|WARN|ERROR|WARNING):\s+(.+)$/is);
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
   * Add a log to the local buffer AND broadcast it live via stateManager.
   */
  private addAndBroadcast(level: LogEntry['level'], source: string, message: string, accountUri?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      accountUri
    };

    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // Broadcast live to log subscribers
    this.stateManager.addLog(level, source, message, accountUri);
  }

  /**
   * Manually add a log entry (for external callers like baresip-connection.ts)
   */
  addLog(level: LogEntry['level'], source: string, message: string, accountUri?: string): void {
    this.addAndBroadcast(level, source, message, accountUri);
  }

  /**
   * Log rotation: rotate baresip.log when it exceeds LOG_MAX_SIZE.
   * Keeps up to LOG_MAX_FILES rotated files (baresip.log.1 through baresip.log.5).
   * tail -F follows by name and handles rotation automatically.
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(LOG_FILE);
      if (stats.size < LOG_MAX_SIZE) return;

      console.log(`Log rotation: ${LOG_FILE} is ${(stats.size / 1024 / 1024).toFixed(1)} MB, rotating...`);

      // Delete oldest file if it exists
      const oldestFile = `${LOG_FILE}.${LOG_MAX_FILES}`;
      try { await unlink(oldestFile); } catch {}

      // Shift existing rotated files: .4 -> .5, .3 -> .4, etc.
      for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
        const src = `${LOG_FILE}.${i}`;
        const dst = `${LOG_FILE}.${i + 1}`;
        try { await rename(src, dst); } catch {}
      }

      // Rotate current file: baresip.log -> baresip.log.1
      await rename(LOG_FILE, `${LOG_FILE}.1`);

      // The tee process in the baresip container will recreate baresip.log automatically
      // tail -F will detect the new file and continue following it

      this.addAndBroadcast('info', 'system', `Log file rotated (was ${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err: any) {
      // File might not exist yet (container not started)
      if (err.code !== 'ENOENT') {
        console.error('Log rotation error:', err.message);
      }
    }
  }
}
