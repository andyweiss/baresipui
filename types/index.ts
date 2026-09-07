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

export type TalktomeTargetType = 'conference' | 'user';
export type TalktomePttMode = 'audio-level' | 'external';
export type TalktomeEndpointKind = 'user' | 'feed';

export interface TalktomeTarget {
  type: TalktomeTargetType;
  id: number;
}

export interface TalktomePttConfig {
  mode: TalktomePttMode;
  thresholdDb: number;
  holdMs: number;
  /** Inbound GPIO selected as the external PTT source (1-6). */
  gpi: number;
}

export interface TalktomeTallyConfig {
  activeGpo?: number;
  liveGpo?: number;
}

interface TalktomeAccountMappingBase {
  enabled: boolean;
  key: string;
  ptt: TalktomePttConfig;
  tally: TalktomeTallyConfig;
  mixLocalCallers: boolean;
  bitrateBps: number;
  previousAudioSource: string;
  previousAudioPlayer: string;
}

export interface TalktomeUserAccountMapping extends TalktomeAccountMappingBase {
  endpointKind: 'user';
  talktomeUserId: number;
  talktomeFeedId?: never;
  target: TalktomeTarget;
}

export interface TalktomeFeedAccountMapping extends TalktomeAccountMappingBase {
  endpointKind: 'feed';
  talktomeUserId?: never;
  talktomeFeedId: number;
  target: null;
}

export type TalktomeAccountMapping =
  | TalktomeUserAccountMapping
  | TalktomeFeedAccountMapping;

export interface TalktomeBridgeConfig {
  accounts: Record<string, TalktomeAccountMapping>;
}

export interface TalktomeAccountMappingInput {
  enabled?: boolean;
  key?: string;
  endpointKind?: TalktomeEndpointKind;
  talktomeUserId?: number;
  talktomeFeedId?: number;
  target?: TalktomeTarget | null;
  ptt?: Partial<TalktomePttConfig>;
  tally?: TalktomeTallyConfig;
  mixLocalCallers?: boolean;
  bitrateBps?: number;
  previousAudioSource?: string;
  previousAudioPlayer?: string;
}

export type TalktomeBridgePhase =
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'connected'
  | 'degraded'
  | 'stopping'
  | 'failed';

export interface TalktomeBridgeStatus {
  accountUri: string;
  key: string;
  phase: TalktomeBridgePhase;
  activeCallIds: string[];
  sessionId?: string;
  producerId?: string;
  consumerCount: number;
  pttLive: boolean;
  pttLocked: boolean;
  eventTransport: 'sse' | 'poll' | 'disconnected';
  lastError?: string;
  updatedAt: number;
}

export type TalktomeBridgeGlobalPhase =
  | 'disabled'
  | 'waiting-baresip'
  | 'starting'
  | 'connected'
  | 'degraded'
  | 'failed'
  | 'stopping';

export interface TalktomeBridgeGlobalStatus {
  enabled: boolean;
  phase: TalktomeBridgeGlobalPhase;
  baresipConnected: boolean;
  serverReachable: boolean;
  /** Highest talktome release this bridge build/runtime was tested against. */
  testedVersion?: string;
  /** talktome server version reported by health/announce when available. */
  serverVersion?: string;
  /** True when serverVersion is strictly newer than testedVersion. */
  serverNewerThanTested?: boolean;
  lastError?: string;
  updatedAt: number;
}

export interface TalktomeBridgeServerUserPort {
  id: string;
  kind: 'user';
  userId: number;
  label: string;
  enabled: boolean;
  trigger: {
    mode: TalktomePttMode;
    target: TalktomeTarget | null;
    thresholdDb: number;
  };
  triggerTargets: Array<TalktomeTarget & { name: string }>;
}

export interface TalktomeBridgeServerFeedPort {
  id: string;
  kind: 'feed';
  feedId: number;
  label: string;
  enabled: boolean;
  input: {
    deviceId: string;
    leftChannel: number;
    rightChannel: number;
  };
}

export interface TalktomeBridgeConfigResponse {
  enabled: boolean;
  globalStatus: TalktomeBridgeGlobalStatus;
  mappings: Record<string, TalktomeAccountMapping>;
  statuses: TalktomeBridgeStatus[];
  server: {
    bridgeId: string;
    revision: string;
    userPorts: TalktomeBridgeServerUserPort[];
    feedPorts: TalktomeBridgeServerFeedPort[];
  } | null;
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
  onHold?: boolean;
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
    current: number;    // ms - current aubuf delay
  };
}

export interface AudioMeter {
  accountUri: string;
  txL: number;   // dBFS (negative, e.g. -18.2)
  txR: number;   // dBFS
  rxL: number;   // dBFS
  rxR: number;   // dBFS
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
// ---- File-based config entries (used by CRUD management UI) ----

export interface ContactFileEntry {
  name: string
  uri: string                          // sip:user@domain
  presence: 'none' | 'p2p'
  access?: 'allow' | 'block'
}

export interface AccountFileEntry {
  name: string
  uri: string                          // sip:user@domain
  enabled: boolean                     // false = line commented out with #
  transport: 'udp' | 'tcp' | 'tls'
  auth_pass: string
  answermode: 'manual' | 'early' | 'auto'
  regint: number
  audio_source: string                 // e.g. "alsa,in_ch1"
  audio_player: string                 // e.g. "alsa,out_ch1"
  pubint: number
  inreq_allowed: boolean
}

// Curated subset of baresip's core config (baresip/config/config) editable
// from the Settings tab. Audio-only deployment — no video keys.
export const BARESIP_CONFIG_KEYS = [
  'sip_trace', 'sip_debug', 'log_level', 'sip_tos',
  'call_local_timeout', 'call_max_calls', 'call_hold_other_calls', 'call_accept',
  'audio_player', 'audio_source', 'audio_alert', 'ausrc_srate', 'auplay_srate',
  'audio_level', 'audio_buffer', 'audio_buffer_mode', 'audio_silence', 'audio_telev_pt',
  'rtp_tos',
  'audio_jitter_buffer_type', 'audio_jitter_buffer_ms', 'audio_jitter_buffer_size',
  'rtp_stats', 'rtp_timeout',
  'opus_bitrate', 'opus_stereo', 'opus_cbr', 'opus_complexity', 'opus_application', 'opus_samplerate',
] as const;

export type BaresipConfigKey = typeof BARESIP_CONFIG_KEYS[number];

export const BARESIP_CONFIG_GROUPS = [
  'SIP & Logging',
  'Call Handling',
  'Audio Devices',
  'Audio Processing',
  'RTP & Jitter Buffer',
  'Opus Codec',
] as const;

export type BaresipConfigGroup = typeof BARESIP_CONFIG_GROUPS[number];

export type BaresipConfigFieldType =
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float' }
  | { kind: 'range' }
  | { kind: 'string' };

export interface BaresipConfigField {
  label: string
  group: BaresipConfigGroup
  type: BaresipConfigFieldType
  help?: string
  /** Suggest ALSA devices of this direction in the input's datalist. */
  devices?: 'input' | 'output'
}

export const BARESIP_CONFIG_FIELDS: Record<BaresipConfigKey, BaresipConfigField> = {
  sip_trace: { label: 'SIP trace', group: 'SIP & Logging', type: { kind: 'bool' }, help: 'Log every SIP message.' },
  sip_debug: { label: 'SIP debug', group: 'SIP & Logging', type: { kind: 'bool' } },
  log_level: { label: 'Log level', group: 'SIP & Logging', type: { kind: 'enum', values: ['debug', 'info', 'warn', 'error'] } },
  sip_tos: { label: 'SIP ToS', group: 'SIP & Logging', type: { kind: 'int', min: 0, max: 255 }, help: 'IP type-of-service byte for SIP signalling.' },

  call_local_timeout: { label: 'Local ring timeout (s)', group: 'Call Handling', type: { kind: 'int', min: 0, max: 86400 }, help: '0 disables the timeout.' },
  call_max_calls: { label: 'Max simultaneous calls', group: 'Call Handling', type: { kind: 'int', min: 1, max: 1000 } },
  call_hold_other_calls: { label: 'Hold other calls', group: 'Call Handling', type: { kind: 'bool' }, help: 'Put running calls on hold when a new one is answered.' },
  call_accept: { label: 'Accept incoming calls', group: 'Call Handling', type: { kind: 'bool' } },

  audio_player: { label: 'Audio player', group: 'Audio Devices', type: { kind: 'string' }, devices: 'output', help: 'Module and device, e.g. "alsa,default".' },
  audio_source: { label: 'Audio source', group: 'Audio Devices', type: { kind: 'string' }, devices: 'input' },
  audio_alert: { label: 'Audio alert', group: 'Audio Devices', type: { kind: 'string' }, devices: 'output', help: 'Device used for ringtones.' },
  ausrc_srate: { label: 'Source sample rate', group: 'Audio Devices', type: { kind: 'int', min: 8000, max: 192000 } },
  auplay_srate: { label: 'Player sample rate', group: 'Audio Devices', type: { kind: 'int', min: 8000, max: 192000 } },

  audio_level: { label: 'Audio level', group: 'Audio Processing', type: { kind: 'bool' }, help: 'Send client-to-mixer audio level (RFC 6464).' },
  audio_buffer: { label: 'Audio buffer (ms)', group: 'Audio Processing', type: { kind: 'range' }, help: 'Range "low-high", e.g. "100-400".' },
  audio_buffer_mode: { label: 'Audio buffer mode', group: 'Audio Processing', type: { kind: 'enum', values: ['fixed', 'adaptive'] } },
  audio_silence: { label: 'Silence threshold (dB)', group: 'Audio Processing', type: { kind: 'float' } },
  audio_telev_pt: { label: 'Telephone-event payload type', group: 'Audio Processing', type: { kind: 'int', min: 0, max: 127 }, help: 'DTMF (RFC 4733) payload type.' },

  rtp_tos: { label: 'RTP ToS', group: 'RTP & Jitter Buffer', type: { kind: 'int', min: 0, max: 255 } },
  audio_jitter_buffer_type: { label: 'Jitter buffer type', group: 'RTP & Jitter Buffer', type: { kind: 'enum', values: ['off', 'fixed', 'adaptive'] } },
  audio_jitter_buffer_ms: { label: 'Jitter buffer (ms)', group: 'RTP & Jitter Buffer', type: { kind: 'range' }, help: 'Range "low-high", e.g. "100-200".' },
  audio_jitter_buffer_size: { label: 'Jitter buffer size (packets)', group: 'RTP & Jitter Buffer', type: { kind: 'int', min: 1, max: 10000 } },
  rtp_stats: { label: 'RTP statistics', group: 'RTP & Jitter Buffer', type: { kind: 'bool' } },
  rtp_timeout: { label: 'RTP timeout (s)', group: 'RTP & Jitter Buffer', type: { kind: 'int', min: 0, max: 3600 }, help: 'Hang up when no RTP arrives for this long. 0 disables.' },

  opus_bitrate: { label: 'Opus bitrate (bit/s)', group: 'Opus Codec', type: { kind: 'int', min: 6000, max: 510000 } },
  opus_stereo: { label: 'Opus stereo', group: 'Opus Codec', type: { kind: 'bool' } },
  opus_cbr: { label: 'Opus constant bitrate', group: 'Opus Codec', type: { kind: 'bool' } },
  opus_complexity: { label: 'Opus complexity', group: 'Opus Codec', type: { kind: 'int', min: 0, max: 10 } },
  opus_application: { label: 'Opus application', group: 'Opus Codec', type: { kind: 'enum', values: ['voip', 'audio'] } },
  opus_samplerate: { label: 'Opus sample rate', group: 'Opus Codec', type: { kind: 'int', min: 8000, max: 192000 } },
};

/**
 * One curated key exactly as it exists in the config file. The file is the only
 * source of truth: no defaults are ever substituted for what it does not contain.
 */
export interface BaresipConfigEntry {
  /** Raw value as written in the file, or null when the key has no line at all. */
  value: string | null
  /** false = a line exists for the key but is commented out with '#'. */
  enabled: boolean
  /** false = the file has no line for this key, so it cannot be edited here. */
  present: boolean
}

export type BaresipConfigEntries = Record<BaresipConfigKey, BaresipConfigEntry>;

/**
 * Validates a raw config-file value. Returns an error message, or null when the
 * value is acceptable. Shared by the API handler and the settings form so both
 * enforce exactly the same rules.
 */
export function validateBaresipConfigValue(key: BaresipConfigKey, value: string): string | null {
  const field = BARESIP_CONFIG_FIELDS[key];
  if (!field) return `${key} is not an editable setting`;
  if (typeof value !== 'string' || value.length === 0) return 'Value is required';
  if (value.length > 256) return 'Value is too long (max 256 characters)';
  if (/[#\r\n\0]/.test(value)) return 'Value may not contain "#" or line breaks';

  const type = field.type;
  switch (type.kind) {
    case 'bool':
      return value === 'yes' || value === 'no' ? null : 'Must be "yes" or "no"';
    case 'enum':
      return type.values.includes(value) ? null : `Must be one of: ${type.values.join(', ')}`;
    case 'int': {
      if (!/^-?\d+$/.test(value)) return 'Must be a whole number';
      const parsed = parseInt(value, 10);
      return parsed < type.min || parsed > type.max
        ? `Must be between ${type.min} and ${type.max}`
        : null;
    }
    case 'float':
      return Number.isFinite(Number(value)) ? null : 'Must be a number';
    case 'range': {
      const match = value.match(/^(\d+)-(\d+)$/);
      return match && parseInt(match[1], 10) <= parseInt(match[2], 10)
        ? null
        : 'Must be a range "low-high" with low ≤ high';
    }
    case 'string':
      return null;
  }
}

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
