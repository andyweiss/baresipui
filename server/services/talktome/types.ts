import type {
  TalktomeAccountMapping,
  TalktomeTarget,
  TalktomeTargetType,
} from '../talktome-bridge-config';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BridgeAudioChannelPair {
  label: string;
  left_channel: number;
  right_channel: number;
}

export interface BridgeAudioDevice {
  id: string;
  name: string;
  direction: 'input' | 'output';
  is_default: boolean;
  max_channels: number;
  supports_48k: boolean;
  channel_pairs: BridgeAudioChannelPair[];
}

export interface BridgeInventory {
  host: string;
  devices: BridgeAudioDevice[];
}

export interface BridgeAnnounceRequest {
  bridgeId: string;
  bridgeName?: string;
  name?: string;
  platform: string;
  inventory: BridgeInventory;
}

export interface BridgeRegistryEntry {
  id: string;
  name: string;
  platform: string;
  host: string;
  inventory: BridgeInventory;
  connectedAt: string;
  lastSeenAt: string;
  remoteAddress: string | null;
  stale: boolean;
}

export interface BridgePortDeviceSelection {
  deviceId: string;
  leftChannel: number;
  rightChannel: number;
}

export interface BridgeTriggerConfig {
  mode: 'audio-level' | 'external';
  target: TalktomeTarget | null;
  thresholdDb: number;
}

export interface BridgeTriggerTarget extends TalktomeTarget {
  name: string;
}

export interface BridgeUserPort {
  id: string;
  kind: 'user';
  userId: number;
  feedId: null;
  label: string;
  enabled: boolean;
  input: BridgePortDeviceSelection;
  output: BridgePortDeviceSelection;
  trigger: BridgeTriggerConfig;
  triggerTargets: BridgeTriggerTarget[];
  updatedAt: string | null;
}

export interface BridgeFeedPort {
  id: string;
  kind: 'feed';
  userId: null;
  feedId: number;
  label: string;
  enabled: boolean;
  input: BridgePortDeviceSelection;
  output: null;
  updatedAt: string | null;
}

export type BridgePort = BridgeUserPort | BridgeFeedPort;

export interface BridgeRuntimeConfig {
  bridgeId: string;
  revision: string;
  ports: BridgePort[];
}

export interface BridgeAnnounceResponse {
  bridge: BridgeRegistryEntry;
  bridgeToken: string;
  config: BridgeRuntimeConfig;
  /** Present when the server includes app/server version on announce. */
  appVersion?: string;
}

export interface BridgeHealthResponse {
  ok: boolean;
  serverStartedAt?: string;
  /** Present when the server exposes appVersion on GET /api/v1/health. */
  appVersion?: string;
}

/**
 * The endpoint API expects flattened database-facing fields, not the nested
 * shape returned by GET /config.
 */
export interface BridgeUserEndpointUpdate {
  inputDevice?: string;
  inputLeftChannel?: number | null;
  inputRightChannel?: number | null;
  outputDevice?: string;
  outputLeftChannel?: number | null;
  outputRightChannel?: number | null;
  triggerMode: 'audio-level' | 'external';
  triggerTargetType?: TalktomeTargetType | '';
  triggerTargetId?: number | null;
  triggerThresholdDb?: number;
}

export interface BridgeFeedEndpointUpdate {
  inputDevice?: string;
  inputLeftChannel?: number | null;
  inputRightChannel?: number | null;
}

export interface BridgeSessionResponse {
  sessionId: string;
  port: BridgePort;
}

export type BridgeSessionEndpoint =
  | { userId: number }
  | { feedId: number };

export interface BridgePlainSendTransport {
  id: string;
  ip: string;
  port: number;
  protocol: string;
  payloadType: number;
  ssrc: number;
}

export interface BridgeProducer {
  id: string;
}

export interface BridgeProducerState {
  ok: boolean;
  paused: boolean;
}

export interface BridgeRtpCodecParameters {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  parameters?: Record<string, JsonPrimitive>;
  rtcpFeedback?: JsonObject[];
}

export interface BridgeRtpEncodingParameters {
  ssrc?: number;
  [key: string]: JsonValue | undefined;
}

export interface BridgeRtpParameters {
  codecs: BridgeRtpCodecParameters[];
  encodings: BridgeRtpEncodingParameters[];
  rtcp?: {
    cname?: string;
    reducedSize?: boolean;
    mux?: boolean;
  };
}

export interface BridgeConsumerTransport {
  ip: string;
  port: number;
  protocol: string;
  rtcpMux: true;
  comedia: true;
}

export interface BridgeConsumer {
  id: string;
  producerId: string;
  kind: string;
  rtpParameters: BridgeRtpParameters;
  transport: BridgeConsumerTransport;
}

export interface BridgeActiveProducer {
  peerId: string;
  producerId: string;
  appData: JsonObject;
  retainOnly?: boolean;
  speakerUserId?: number | null;
  speakerName?: string | null;
  speakerKind?: string | null;
}

export interface BridgeActiveProducersResponse {
  producers: BridgeActiveProducer[];
}

export interface BridgeControlEvent<TPayload = JsonObject> {
  id: string;
  event: BridgeControlEventName;
  payload: TPayload;
  at: string;
}

export type BridgeControlEventName =
  | 'new-producer'
  | 'producer-closed'
  | 'consumer-closed'
  | 'incoming-talk-state'
  | 'api-talk-command'
  | 'api-target-audio-command'
  | 'session-kicked';

export interface BridgeProducerEventPayload {
  peerId: string;
  producerId: string;
  appData: JsonObject;
  retainOnly?: boolean;
  speakerUserId?: number | null;
  speakerName?: string | null;
  speakerKind?: string | null;
}

export interface BridgeConsumerClosedPayload {
  consumerId: string;
  producerId?: string;
}

export interface BridgeIncomingTalkEntry {
  targetType: 'user' | 'conference';
  targetId: number;
  at: number;
}

export interface BridgeIncomingTalkStatePayload {
  reason?: string;
  at?: string;
  state?: {
    userId?: number | null;
    guestId?: string | null;
    addressedNow?: BridgeIncomingTalkEntry[];
    replyTarget?: BridgeIncomingTalkEntry | null;
  };
}

export type BridgeTalkCommandAction = 'press' | 'release' | 'lock-toggle';

export interface BridgeTalkCommandPayload {
  commandId?: string;
  sentAt?: string;
  action: BridgeTalkCommandAction;
  targetType?: 'conference' | 'user' | 'reply';
  targetId?: number;
  inputKey?: string;
}

export type BridgeTargetAudioAction = 'volume-up' | 'volume-down' | 'mute-toggle';

export interface BridgeTargetAudioCommandPayload {
  commandId?: string;
  sentAt?: string;
  action: BridgeTargetAudioAction;
  targetType: 'conference' | 'user' | 'feed';
  targetId: number;
  step?: number;
}

export interface BridgeTalkStateRequest {
  talking: boolean;
  targets: TalktomeTarget[];
  lockActive: boolean;
}

export interface BridgeTalkStateResponse {
  ok: boolean;
  talking: boolean;
  targets: TalktomeTarget[];
}

export interface BridgeCommandResultRequest {
  commandId: string;
  ok: boolean;
  action?: string;
  targetType?: string;
  targetId?: number;
  reason?: string;
}

export interface BridgeMediaDiagnostics {
  input?: JsonValue;
  outputs?: JsonValue;
  module?: JsonValue;
}

export interface BridgeLifecycleEvent {
  event: string;
  detail?: string;
}

export interface BridgeHeartbeatRequest {
  mediaDiagnostics?: BridgeMediaDiagnostics | null;
  lifecycleEvents?: BridgeLifecycleEvent[];
}

export interface BridgePollEventsResponse {
  events: BridgeControlEvent[];
}

export interface BridgeOkResponse {
  ok: boolean;
}

export interface BridgeApi {
  announce(request: BridgeAnnounceRequest): Promise<BridgeAnnounceResponse>;
  getHealth?(): Promise<BridgeHealthResponse>;
  getConfig(bridgeId: string): Promise<BridgeRuntimeConfig>;
  putUserEndpoint(
    bridgeId: string,
    userId: number,
    update: BridgeUserEndpointUpdate,
  ): Promise<BridgeRuntimeConfig>;
  putFeedEndpoint(
    bridgeId: string,
    feedId: number,
    update: BridgeFeedEndpointUpdate,
  ): Promise<BridgeRuntimeConfig>;
  createSession(
    bridgeId: string,
    endpoint: BridgeSessionEndpoint,
  ): Promise<BridgeSessionResponse>;
  deleteSession(sessionId: string, reason?: string): Promise<BridgeOkResponse>;
  heartbeat(
    sessionId: string,
    request: BridgeHeartbeatRequest,
  ): Promise<BridgeOkResponse>;
  pollEvents(sessionId: string, signal?: AbortSignal): Promise<BridgeControlEvent[]>;
  openEventStream(sessionId: string, signal: AbortSignal): Promise<Response>;
  getActiveProducers(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BridgeActiveProducer[]>;
  createPlainSendTransport(sessionId: string): Promise<BridgePlainSendTransport>;
  createProducer(
    sessionId: string,
    payloadType?: number,
    ssrc?: number,
  ): Promise<BridgeProducer>;
  pauseProducer(sessionId: string, producerId: string): Promise<BridgeProducerState>;
  resumeProducer(sessionId: string, producerId: string): Promise<BridgeProducerState>;
  setTalkState(
    sessionId: string,
    request: BridgeTalkStateRequest,
  ): Promise<BridgeTalkStateResponse>;
  createConsumer(sessionId: string, producerId: string): Promise<BridgeConsumer>;
  resumeConsumer(sessionId: string, consumerId: string): Promise<BridgeOkResponse>;
  deleteConsumer(sessionId: string, consumerId: string): Promise<BridgeOkResponse>;
  sendCommandResult(
    sessionId: string,
    result: BridgeCommandResultRequest,
  ): Promise<BridgeOkResponse>;
}

export interface AccountMappingProvider {
  getAccount(accountUri: string): TalktomeAccountMapping | undefined;
  getEnabledAccounts?(): Array<[string, TalktomeAccountMapping]>;
}
