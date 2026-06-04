import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import { stateManager } from './state-manager';

export const registry = new Registry();

// --- Gauges (populated from stateManager on each scrape) ---

new Gauge({
  name: 'baresip_account_registered',
  help: 'SIP account registration status (1 = registered, 0 = unregistered)',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const account of stateManager.getAccounts()) {
      this.set({ account: account.uri }, account.registered ? 1 : 0);
    }
  }
});

new Gauge({
  name: 'baresip_active_calls_count',
  help: 'Number of currently active SIP calls',
  registers: [registry],
  collect() {
    this.set(stateManager.getCalls().length);
  }
});

new Gauge({
  name: 'baresip_rtcp_jitter_rx_ms',
  help: 'RTCP receive jitter in milliseconds',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioRxStats?.jitter !== undefined) {
        this.set({ account: call.localUri }, call.audioRxStats.jitter);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_jitter_tx_ms',
  help: 'RTCP transmit jitter in milliseconds',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioTxStats?.jitter !== undefined) {
        this.set({ account: call.localUri }, call.audioTxStats.jitter);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_rtt_ms',
  help: 'RTCP round-trip time in milliseconds',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioRxStats?.rtt !== undefined) {
        this.set({ account: call.localUri }, call.audioRxStats.rtt);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_lost_rx_packets',
  help: 'RTCP cumulative receive packets lost',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioRxStats?.packetsLost !== undefined) {
        this.set({ account: call.localUri }, call.audioRxStats.packetsLost);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_lost_tx_packets',
  help: 'RTCP cumulative transmit packets lost',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioTxStats?.packetsLost !== undefined) {
        this.set({ account: call.localUri }, call.audioTxStats.packetsLost);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_rx_bitrate_kbps',
  help: 'RTCP receive bitrate in kbps',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioRxStats?.bitrate_kbps !== undefined) {
        this.set({ account: call.localUri }, call.audioRxStats.bitrate_kbps);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_tx_bitrate_kbps',
  help: 'RTCP transmit bitrate in kbps',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.audioTxStats?.bitrate_kbps !== undefined) {
        this.set({ account: call.localUri }, call.audioTxStats.bitrate_kbps);
      }
    }
  }
});

new Gauge({
  name: 'baresip_rtcp_jbuf_delay_ms',
  help: 'Jitter buffer current delay in milliseconds',
  labelNames: ['account'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const call of stateManager.getCalls()) {
      if (call.jitterBuffer?.current !== undefined) {
        this.set({ account: call.localUri }, call.jitterBuffer.current);
      }
    }
  }
});

// --- Counters (incremented by event handlers in baresip-parser.ts) ---

const registrationCounter = new Counter({
  name: 'baresip_registration_changes_total',
  help: 'Total SIP registration state changes',
  labelNames: ['account', 'result'] as const,
  registers: [registry]
});

const callsCounter = new Counter({
  name: 'baresip_calls_total',
  help: 'Total SIP calls started (incoming or outgoing)',
  labelNames: ['account', 'direction'] as const,
  registers: [registry]
});

// --- Histogram (observed when a call ends) ---

const callDurationHistogram = new Histogram({
  name: 'baresip_call_duration_seconds',
  help: 'SIP call duration in seconds (from call start to close)',
  labelNames: ['account', 'direction'] as const,
  // Buckets: 1min, 5min, 30min, 1h, 4h, 12h, 1d, 3d, 1w
  buckets: [60, 300, 1800, 3600, 14400, 43200, 86400, 259200, 604800],
  registers: [registry]
});

export function recordRegistrationEvent(account: string, result: 'ok' | 'fail'): void {
  registrationCounter.inc({ account, result });
}

export function recordCallStarted(account: string, direction: 'incoming' | 'outgoing'): void {
  callsCounter.inc({ account, direction });
}

export function recordCallEnded(account: string, direction: 'incoming' | 'outgoing', durationMs: number): void {
  callDurationHistogram.observe({ account, direction }, durationMs / 1000);
}
