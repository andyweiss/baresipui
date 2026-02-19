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
  private pendingLogLine = ''; // Für mehrzeilige Logs

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  start(containerName: string = 'baresip'): void {
    console.log(`📝 Starting baresip logger (RTC stats via TCP socket)`);
    // RTC stats are now delivered via getrtcpstats command (TCP socket)
    // This logger remains for general log collection if needed
  }

  stop(): void {
    // Process any pending log line before stopping
    if (this.pendingLogLine && this.logProcess) {
      this.processLogEntry(this.pendingLogLine, 'stdout');
      this.pendingLogLine = '';
    }
    
    if (this.logProcess) {
      this.logProcess.kill();
      this.logProcess = null;
    }
  }

  private processLogData(data: string, stream: 'stdout' | 'stderr'): void {
    const lines = data.split('\n');
    
    // Count how many rtcpstats lines we have
    const rtcpCount = lines.filter(l => l.includes('rtcpstats_periodic: call_id')).length;
    if (rtcpCount > 0) {
      this.stateManager.broadcast({
        type: 'debug',
        data: {message: `📥 Got ${rtcpCount} rtcpstats lines in this block`}
      });
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      
      // Skip JSON event messages (they are handled by baresip-parser)
      if (line.trim().startsWith('{') && line.trim().includes('"event":true')) {
        continue;
      }
      
      // Check if this is a new log entry (starts with module: or is standalone)
      // Typical pattern: "module: message" or starts with uppercase word
      const isNewEntry = /^[a-z_]+:\s+/i.test(line) || 
                        /^[A-Z]+:\s+/.test(line) ||
                        (!this.pendingLogLine && line.trim().length > 0);
      
      if (isNewEntry && this.pendingLogLine) {
        // Process the previous pending log
        this.processLogEntry(this.pendingLogLine, stream);
        this.pendingLogLine = line;
      } else if (isNewEntry) {
        // Start new log
        this.pendingLogLine = line;
      } else {
        // Append to pending log (continuation line)
        this.pendingLogLine += '\n' + line;
      }
    }
    
    // Process any remaining log after a short delay (in case more lines are coming)
    // This is handled by checking on next data chunk
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
    
    // Handle rtcpstats_periodic data directly
    if (line.includes('rtcpstats_periodic:') && line.includes('call_id=')) {
      this.parseRtcpStatsLine(line);
      return; // Don't log this as a regular entry
    }
    
    // Debug: Log original line length
    if (line.length > 200) {
      console.log(`📏 Long log line (${line.length} chars): ${line.substring(0, 100)}...`);
    }
    
    const entry = this.parseLogLine(line, stream);
    
    // Skip entries with empty messages
    if (!entry.message || entry.message.length < 2) {
      return;
    }
    
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
    console.log(`${emoji} [${entry.source}] ${entry.message.substring(0, 100)}${entry.message.length > 100 ? '...' : ''}`);
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

  private parseRtcpStatsLine(line: string): void {
    // Parse: rtcpstats_periodic: call_id=xxx rx_packets=123 tx_packets=456 rx_bitrate_kbps=0 tx_bitrate_kbps=1 rx_dropout=false rx_dropout_total=0
    console.log('📊 Processing rtcpstats_periodic line from logger:', line.substring(0, 80));
    
    // Extract call_id
    const callIdMatch = line.match(/call_id=([a-f0-9]+)/);
    if (!callIdMatch) {
      console.log('⚠️ No call_id found in rtcpstats line');
      return;
    }
    
    const callId = callIdMatch[1];
    
    // Extract all metrics
    const metrics: any = { call_id: callId };
    
    const patterns = [
      { key: 'rx_packets', regex: /rx_packets=(\d+)/ },
      { key: 'tx_packets', regex: /tx_packets=(\d+)/ },
      { key: 'rx_bitrate_kbps', regex: /rx_bitrate_kbps=(\d+)/ },
      { key: 'tx_bitrate_kbps', regex: /tx_bitrate_kbps=(\d+)/ },
      { key: 'rx_dropout', regex: /rx_dropout=(true|false)/ },
      { key: 'rx_dropout_total', regex: /rx_dropout_total=(\d+)/ }
    ];
    
    for (const { key, regex } of patterns) {
      const match = line.match(regex);
      if (match) {
        if (key === 'rx_dropout') {
          metrics[key] = match[1] === 'true';
        } else {
          metrics[key] = parseInt(match[1], 10);
        }
      }
    }
    
    console.log('✅ Parsed RTCP stats:', metrics);
    
    // Update call in StateManager with these metrics
    const call = this.stateManager.getCall(callId);
    if (!call) {
      console.log('⚠️ Call not found:', callId);
      return;
    }
    
    // Update audio RX stats
    if (!call.audioRxStats) {
      call.audioRxStats = {
        packets: 0,
        lost: 0,
        bitrate_kbps: 0,
        dropout: false,
        dropout_total: 0,
        rtp_rx_errors: 0,
        jitter: 0
      };
    }
    
    if (metrics.rx_packets !== undefined) {
      call.audioRxStats.packets = metrics.rx_packets;
    }
    if (metrics.rx_bitrate_kbps !== undefined) {
      call.audioRxStats.bitrate_kbps = metrics.rx_bitrate_kbps;
    }
    if (metrics.rx_dropout !== undefined) {
      call.audioRxStats.dropout = metrics.rx_dropout;
    }
    if (metrics.rx_dropout_total !== undefined) {
      call.audioRxStats.dropout_total = metrics.rx_dropout_total;
    }
    
    // Update audio TX stats
    if (!call.audioTxStats) {
      call.audioTxStats = {
        packets: 0,
        lost: 0,
        bitrate_kbps: 0,
        jitter: 0
      };
    }
    
    if (metrics.tx_packets !== undefined) {
      call.audioTxStats.packets = metrics.tx_packets;
    }
    if (metrics.tx_bitrate_kbps !== undefined) {
      call.audioTxStats.bitrate_kbps = metrics.tx_bitrate_kbps;
    }
    
    // Broadcast the updated call
    this.stateManager.broadcast({
      type: 'callUpdated',
      data: call
    });
    
    console.log('📢 Broadcasted updated call:', callId);
  }

  clearLogs(): void {
    this.logBuffer = [];
    this.stateManager.broadcast({
      type: 'logsCleared',
      data: {}
    });
  }
}
