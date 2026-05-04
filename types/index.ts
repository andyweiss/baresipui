export interface Account {
  uri: string;
  registered: boolean;
  callStatus: string; // 'Idle', 'Ringing', 'In Call', or SIP end reason like "404 Not Found"
  autoConnectStatus: string;
  lastEvent: number;
  configured: boolean;
  registrationError?: string;
  lastRegistrationAttempt?: number;
  source?: string;
  autoConnectContact?: string;
  callId?: string;
  displayName?: string;
}

export interface Contact {
  contact: string;
  name: string;
  enabled: boolean;
  status: string;
  presence: string;
  assignedAccount?: string;
  lastSeen?: number;
}

export interface ContactConfig {
  name: string;
  enabled: boolean;
  status: string;
  source?: string;
  assignedAccount?: string;
}

export interface CallInfo {
  callId: string;
  localUri: string;
  remoteUri: string;
  peerName?: string;
  state: 'Ringing' | 'Established' | 'Closing';
  direction: 'incoming' | 'outgoing';
  startTime: number;
  answerTime?: number;
  endTime?: number;
  duration?: number;
  needsCodecInfo?: boolean;
  codecInfoFetched?: boolean;
  audioCodec?: {
    codec: string;
    sampleRate: number;
    channels: number;
    params?: Record<string, string>;
  };
  txAudioCodec?: { codec: string; sampleRate: number; channels: number; params?: Record<string, string> };
  rxAudioCodec?: { codec: string; sampleRate: number; channels: number; params?: Record<string, string> };
  txCodecs?: Array<{ payloadType: string; codec: string; sampleRate: number; channels: number; params?: Record<string, string> }>;
  rxCodecs?: Array<{ payloadType: string; codec: string; sampleRate: number; channels: number; params?: Record<string, string> }>;
  audioRxStats?: {
    packets: number;
    packetsLost: number;
    jitter: number;       // ms
    rtt?: number;         // ms
    bitrate_kbps: number;
    dropout?: boolean;
    dropout_total?: number;
    rtp_rx_errors?: number;
    rtcp_packets?: number;
  };
  audioTxStats?: {
    packets: number;
    packetsLost: number;
    jitter?: number;      // ms
    bitrate_kbps: number;
    rtp_tx_errors?: number;
    rtcp_packets?: number;
  };
  jitterBuffer?: {
    current: number;    // ms
    min: number;        // ms
    max: number;        // ms
    packets?: number;
  };
}

export interface AudioMeter {
  accountUri: string;
  inputLevel: number;  // dB
  outputLevel: number; // dB
  timestamp: number;
}

export interface BaresipEvent {
  event?: string;
  class?: string;
  type?: string;
  accountaor?: string;
  param?: string;
  event_name?: string;
  local_uri?: string;
  peer_uri?: string;
  remote_uri?: string;
  id?: string;
  peeruri?: string;
  contacturi?: string;
  localuri?: string;
  direction?: 'incoming' | 'outgoing';
  peerdisplayname?: string;
  peername?: string;
}

export interface BaresipCommandResponse {
  response?: boolean;
  ok?: boolean;
  data?: string;
  token?: string;
}

export interface WebSocketMessage {
  type: string;
  timestamp?: number;
  message?: string;
  data?: any;
  accounts?: Account[];
  contacts?: Contact[];
  contact?: string;
  status?: string;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  accountUri?: string;
  data?: any;
}

// GPIO / DTMF

export interface GpioState {
  accountUri: string;
  gpioOut: boolean[]; // 6 outgoing GPIOs (user/ESP32 controlled, sends DTMF)
  gpioIn: boolean[];  // 6 incoming GPIOs (received DTMF from remote peer)
}

/**
 * DTMF-to-GPIO mapping:
 *   Even index = GPIO off, Odd index = GPIO on
 *   GPIO number = Math.floor(index / 2) + 1
 *
 * DTMF 0 = GPIO 1 off    DTMF 1 = GPIO 1 on
 * DTMF 2 = GPIO 2 off    DTMF 3 = GPIO 2 on
 * DTMF 4 = GPIO 3 off    DTMF 5 = GPIO 3 on
 * DTMF 6 = GPIO 4 off    DTMF 7 = GPIO 4 on
 * DTMF 8 = GPIO 5 off    DTMF 9 = GPIO 5 on
 * DTMF * = GPIO 6 off    DTMF # = GPIO 6 on
 */
export const DTMF_DIGITS = ['0','1','2','3','4','5','6','7','8','9','*','#'] as const;

/** Convert GPIO index (1-6) and state (on/off) to DTMF digit */
export function gpioToDtmf(gpioIndex: number, state: boolean): string {
  const dtmfIndex = (gpioIndex - 1) * 2 + (state ? 1 : 0);
  return DTMF_DIGITS[dtmfIndex];
}

/** Convert DTMF digit to GPIO index (1-6) and state (on/off). Returns null for unknown digits. */
export function dtmfToGpio(digit: string): { gpioIndex: number; state: boolean } | null {
  const idx = DTMF_DIGITS.indexOf(digit as any);
  if (idx === -1) return null;
  return { gpioIndex: Math.floor(idx / 2) + 1, state: idx % 2 === 1 };
}

/** Create a default (all off) GPIO state for an account */
export function createDefaultGpioState(accountUri: string): GpioState {
  return {
    accountUri,
    gpioOut: new Array(6).fill(false),
    gpioIn: new Array(6).fill(false),
  };
}
