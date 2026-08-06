import type {
  BridgeActiveProducer,
  BridgeActiveProducersResponse,
  BridgeAnnounceRequest,
  BridgeAnnounceResponse,
  BridgeApi,
  BridgeCommandResultRequest,
  BridgeConsumer,
  BridgeControlEvent,
  BridgeFeedEndpointUpdate,
  BridgeHealthResponse,
  BridgeHeartbeatRequest,
  BridgeOkResponse,
  BridgePlainSendTransport,
  BridgePollEventsResponse,
  BridgeProducer,
  BridgeProducerState,
  BridgeRtpParameters,
  BridgeRuntimeConfig,
  BridgeSessionEndpoint,
  BridgeSessionResponse,
  BridgeTalkStateRequest,
  BridgeTalkStateResponse,
  BridgeUserEndpointUpdate,
  JsonObject,
} from './types';
import { extractTalktomeAppVersion } from './version';

export type BridgeAuthMode = 'bearer' | 'api-key';

export interface TalktomeBridgeHttpClientOptions {
  baseUrl: string;
  token: string;
  authMode?: BridgeAuthMode;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  adoptAnnouncedBridgeToken?: boolean;
}

export class BridgeHttpError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly responseBody?: unknown;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    method: string;
    url: string;
    status?: number;
    responseBody?: unknown;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeHttpError';
    this.method = options.method;
    this.url = options.url;
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.retryable =
      options.status === undefined ||
      options.status === 408 ||
      options.status === 425 ||
      options.status === 429 ||
      options.status >= 500;
  }
}

export function normalizeTalktomeBaseUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Talktome base URL is required');
  }
  const trimmed = value.trim();
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Talktome base URL is invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Talktome base URL must use HTTPS or HTTP');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Talktome base URL must contain a host without credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Talktome base URL must not contain a query or fragment');
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Dependency-free client for the verified talktome Bridge Plain-RTP API.
 */
export class TalktomeBridgeHttpClient implements BridgeApi {
  readonly baseUrl: string;
  private token: string;
  private readonly authMode: BridgeAuthMode;
  private readonly requestTimeoutMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly adoptAnnouncedBridgeToken: boolean;

  constructor(options: TalktomeBridgeHttpClientOptions) {
    this.baseUrl = normalizeTalktomeBaseUrl(options.baseUrl);
    this.token = requireToken(options.token);
    this.authMode = options.authMode ?? 'bearer';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 100 ||
      this.requestTimeoutMs > 120_000
    ) {
      throw new Error('Bridge HTTP timeout must be between 100 and 120000 ms');
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('Native fetch is unavailable');
    }
    this.adoptAnnouncedBridgeToken = options.adoptAnnouncedBridgeToken ?? true;
  }

  setToken(token: string): void {
    this.token = requireToken(token);
  }

  async announce(request: BridgeAnnounceRequest): Promise<BridgeAnnounceResponse> {
    const response = await this.requestJson(
      'POST',
      '/api/v1/bridge/announce',
      request,
      parseAnnounceResponse,
    );
    if (this.adoptAnnouncedBridgeToken && response.bridgeToken) {
      this.token = response.bridgeToken;
    }
    return response;
  }

  getConfig(bridgeId: string): Promise<BridgeRuntimeConfig> {
    return this.requestJson(
      'GET',
      `/api/v1/bridge/${segment(bridgeId)}/config`,
      undefined,
      parseRuntimeConfig,
    );
  }

  /**
   * GET /api/v1/health does not require auth on current talktome servers.
   * This client still sends the configured bridge credentials, matching other
   * BridgeApi calls. Prefer `appVersion` here when the server exposes it
   * (same field name as `/admin/status`).
   */
  getHealth(): Promise<BridgeHealthResponse> {
    return this.requestJson('GET', '/api/v1/health', undefined, parseHealth);
  }

  putUserEndpoint(
    bridgeId: string,
    userId: number,
    update: BridgeUserEndpointUpdate,
  ): Promise<BridgeRuntimeConfig> {
    return this.requestJson(
      'PUT',
      `/api/v1/bridge/${segment(bridgeId)}/ports/user/${positiveId(userId, 'userId')}`,
      update,
      parseRuntimeConfig,
    );
  }

  putFeedEndpoint(
    bridgeId: string,
    feedId: number,
    update: BridgeFeedEndpointUpdate,
  ): Promise<BridgeRuntimeConfig> {
    return this.requestJson(
      'PUT',
      `/api/v1/bridge/${segment(bridgeId)}/ports/feed/${positiveId(feedId, 'feedId')}`,
      update,
      parseRuntimeConfig,
    );
  }

  createSession(
    bridgeId: string,
    endpoint: BridgeSessionEndpoint,
  ): Promise<BridgeSessionResponse> {
    return this.requestJson(
      'POST',
      '/api/v1/bridge/sessions',
      { bridgeId, ...sessionEndpointBody(endpoint) },
      parseSession,
    );
  }

  deleteSession(sessionId: string, reason?: string): Promise<BridgeOkResponse> {
    return this.requestJson(
      'DELETE',
      `${sessionPath(sessionId)}`,
      reason ? { reason } : undefined,
      parseOk,
    );
  }

  heartbeat(
    sessionId: string,
    request: BridgeHeartbeatRequest,
  ): Promise<BridgeOkResponse> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/heartbeat`,
      request,
      parseOk,
    );
  }

  async pollEvents(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BridgeControlEvent[]> {
    const response = await this.requestJson(
      'GET',
      `${sessionPath(sessionId)}/events`,
      undefined,
      parsePollEvents,
      signal,
    );
    return response.events;
  }

  async openEventStream(sessionId: string, signal: AbortSignal): Promise<Response> {
    const method = 'GET';
    const url = this.url(`${sessionPath(sessionId)}/events/stream`);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method,
        headers: this.headers({ Accept: 'text/event-stream' }),
        signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      throw new BridgeHttpError({
        message: `Bridge event stream request failed: ${errorMessage(error)}`,
        method,
        url,
        cause: error,
      });
    }
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw responseError(method, url, response.status, body);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      throw new BridgeHttpError({
        message: `Bridge event stream returned unexpected content type ${
          contentType || '(missing)'
        }`,
        method,
        url,
        status: response.status,
      });
    }
    if (!response.body) {
      throw new BridgeHttpError({
        message: 'Bridge event stream response has no body',
        method,
        url,
        status: response.status,
      });
    }
    return response;
  }

  async getActiveProducers(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BridgeActiveProducer[]> {
    const response = await this.requestJson(
      'GET',
      `${sessionPath(sessionId)}/active-producers`,
      undefined,
      parseActiveProducers,
      signal,
    );
    return response.producers;
  }

  createPlainSendTransport(sessionId: string): Promise<BridgePlainSendTransport> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/plain-send-transport`,
      {},
      parsePlainTransport,
    );
  }

  createProducer(
    sessionId: string,
    payloadType?: number,
    ssrc?: number,
  ): Promise<BridgeProducer> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/producers`,
      {
        ...(payloadType === undefined ? {} : { payloadType }),
        ...(ssrc === undefined ? {} : { ssrc }),
      },
      parseProducer,
    );
  }

  pauseProducer(
    sessionId: string,
    producerId: string,
  ): Promise<BridgeProducerState> {
    return this.producerAction(sessionId, producerId, 'pause');
  }

  resumeProducer(
    sessionId: string,
    producerId: string,
  ): Promise<BridgeProducerState> {
    return this.producerAction(sessionId, producerId, 'resume');
  }

  setTalkState(
    sessionId: string,
    request: BridgeTalkStateRequest,
  ): Promise<BridgeTalkStateResponse> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/talk-state`,
      request,
      parseTalkState,
    );
  }

  createConsumer(sessionId: string, producerId: string): Promise<BridgeConsumer> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/consumers`,
      { producerId: requiredId(producerId, 'producerId'), rtpHandshake: true },
      parseConsumer,
    );
  }

  resumeConsumer(sessionId: string, consumerId: string): Promise<BridgeOkResponse> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/consumers/${segment(consumerId)}/resume`,
      {},
      parseOk,
    );
  }

  deleteConsumer(sessionId: string, consumerId: string): Promise<BridgeOkResponse> {
    return this.requestJson(
      'DELETE',
      `${sessionPath(sessionId)}/consumers/${segment(consumerId)}`,
      undefined,
      parseOk,
    );
  }

  sendCommandResult(
    sessionId: string,
    result: BridgeCommandResultRequest,
  ): Promise<BridgeOkResponse> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/command-result`,
      result,
      parseOk,
    );
  }

  private producerAction(
    sessionId: string,
    producerId: string,
    action: 'pause' | 'resume',
  ): Promise<BridgeProducerState> {
    return this.requestJson(
      'POST',
      `${sessionPath(sessionId)}/producers/${segment(producerId)}/${action}`,
      {},
      parseProducerState,
    );
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const url = this.url(path);
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`Bridge request timed out after ${this.requestTimeoutMs} ms`)),
      this.requestTimeoutMs,
    );

    let response: Response;
    let responseBody: unknown;
    try {
      response = await this.fetchImplementation(url, {
        method,
        headers: this.headers(
          body === undefined ? undefined : { 'Content-Type': 'application/json' },
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      responseBody = await readResponseBody(response);
    } catch (error) {
      if (externalSignal?.aborted || isAbortError(error)) throw error;
      throw new BridgeHttpError({
        message: `${method} ${path} failed: ${errorMessage(error)}`,
        method,
        url,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }

    if (!response.ok) {
      throw responseError(method, url, response.status, responseBody);
    }
    try {
      return parse(responseBody);
    } catch (error) {
      throw new BridgeHttpError({
        message: `${method} ${path} returned an invalid response: ${errorMessage(error)}`,
        method,
        url,
        status: response.status,
        responseBody,
        cause: error,
      });
    }
  }

  private headers(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    if (this.authMode === 'api-key') headers.set('x-api-key', this.token);
    else headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  private url(pathname: string): string {
    return `${this.baseUrl}${pathname}`;
  }
}

function sessionPath(sessionId: string): string {
  return `/api/v1/bridge/sessions/${segment(sessionId)}`;
}

function segment(value: string): string {
  return encodeURIComponent(requiredId(value, 'path segment'));
}

function requiredId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function sessionEndpointBody(endpoint: BridgeSessionEndpoint): BridgeSessionEndpoint {
  if ('userId' in endpoint) {
    return { userId: positiveId(endpoint.userId, 'userId') };
  }
  return { feedId: positiveId(endpoint.feedId, 'feedId') };
}

function requireToken(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Bridge API token is required');
  }
  if (/[\r\n]/.test(value)) throw new Error('Bridge API token contains invalid characters');
  return value.trim();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 16_384);
  }
}

function responseError(
  method: string,
  url: string,
  status: number,
  body: unknown,
): BridgeHttpError {
  const serverMessage =
    isRecord(body) && typeof body.error === 'string' && body.error.trim()
      ? body.error.trim()
      : `HTTP ${status}`;
  return new BridgeHttpError({
    message: `Bridge API ${method} failed: ${serverMessage}`,
    method,
    url,
    status,
    responseBody: body,
  });
}

function parseAnnounceResponse(value: unknown): BridgeAnnounceResponse {
  const object = expectRecord(value, 'announce response');
  const appVersion = extractTalktomeAppVersion(object);
  return {
    bridge: expectRecord(object.bridge, 'announce bridge') as unknown as BridgeAnnounceResponse['bridge'],
    bridgeToken: expectString(object.bridgeToken, 'bridgeToken'),
    config: parseRuntimeConfig(object.config),
    ...(appVersion ? { appVersion } : {}),
  };
}

function parseHealth(value: unknown): BridgeHealthResponse {
  const object = expectRecord(value, 'health response');
  const appVersion = extractTalktomeAppVersion(object);
  return {
    ok: expectBoolean(object.ok, 'health ok'),
    ...(typeof object.serverStartedAt === 'string' && object.serverStartedAt
      ? { serverStartedAt: object.serverStartedAt }
      : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

function parseRuntimeConfig(value: unknown): BridgeRuntimeConfig {
  const object = expectRecord(value, 'runtime config');
  return {
    bridgeId: expectString(object.bridgeId, 'bridgeId'),
    revision: expectString(object.revision, 'revision'),
    ports: expectArray(object.ports, 'ports') as BridgeRuntimeConfig['ports'],
  };
}

function parseSession(value: unknown): BridgeSessionResponse {
  const object = expectRecord(value, 'session response');
  return {
    sessionId: expectString(object.sessionId, 'sessionId'),
    port: expectRecord(object.port, 'port') as unknown as BridgeSessionResponse['port'],
  };
}

function parsePlainTransport(value: unknown): BridgePlainSendTransport {
  const object = expectRecord(value, 'plain send transport');
  return {
    id: expectString(object.id, 'transport.id'),
    ip: expectString(object.ip, 'transport.ip'),
    port: expectPort(object.port, 'transport.port'),
    protocol: expectString(object.protocol, 'transport.protocol'),
    payloadType: expectPayloadType(object.payloadType, 'transport.payloadType'),
    ssrc: expectPositiveNumber(object.ssrc, 'transport.ssrc'),
  };
}

function parseProducer(value: unknown): BridgeProducer {
  return { id: expectString(expectRecord(value, 'producer').id, 'producer.id') };
}

function parseProducerState(value: unknown): BridgeProducerState {
  const object = expectRecord(value, 'producer state');
  return {
    ok: expectBoolean(object.ok, 'producer state ok'),
    paused: expectBoolean(object.paused, 'producer paused'),
  };
}

function parseTalkState(value: unknown): BridgeTalkStateResponse {
  const object = expectRecord(value, 'talk state');
  return {
    ok: expectBoolean(object.ok, 'talk state ok'),
    talking: expectBoolean(object.talking, 'talking'),
    targets: expectArray(object.targets, 'talk targets') as BridgeTalkStateResponse['targets'],
  };
}

function parseConsumer(value: unknown): BridgeConsumer {
  const object = expectRecord(value, 'consumer');
  const transport = expectRecord(object.transport, 'consumer transport');
  return {
    id: expectString(object.id, 'consumer.id'),
    producerId: expectString(object.producerId, 'consumer.producerId'),
    kind: expectString(object.kind, 'consumer.kind'),
    rtpParameters: parseRtpParameters(object.rtpParameters),
    transport: {
      ip: expectString(transport.ip, 'consumer transport ip'),
      port: expectPort(transport.port, 'consumer transport port'),
      protocol: expectString(transport.protocol, 'consumer transport protocol'),
      rtcpMux: expectTrue(transport.rtcpMux, 'consumer transport rtcpMux'),
      comedia: expectTrue(transport.comedia, 'consumer transport comedia'),
    },
  };
}

function parseRtpParameters(value: unknown): BridgeRtpParameters {
  const object = expectRecord(value, 'RTP parameters');
  const codecs = expectArray(object.codecs, 'RTP codecs').map((entry, index) => {
    const codec = expectRecord(entry, `RTP codec ${index}`);
    return {
      ...codec,
      mimeType: expectString(codec.mimeType, 'RTP codec mimeType'),
      payloadType: expectPayloadType(codec.payloadType, 'RTP codec payloadType'),
      clockRate: expectPositiveNumber(codec.clockRate, 'RTP codec clockRate'),
    };
  });
  if (!codecs.length) throw new Error('RTP parameters contain no codecs');
  return {
    ...object,
    codecs: codecs as BridgeRtpParameters['codecs'],
    encodings: expectArray(object.encodings, 'RTP encodings') as BridgeRtpParameters['encodings'],
    ...(isRecord(object.rtcp)
      ? { rtcp: object.rtcp as unknown as BridgeRtpParameters['rtcp'] }
      : {}),
  };
}

function parseActiveProducers(value: unknown): BridgeActiveProducersResponse {
  const object = expectRecord(value, 'active producers response');
  return {
    producers: expectArray(object.producers, 'active producers').map(parseActiveProducer),
  };
}

function parseActiveProducer(value: unknown): BridgeActiveProducer {
  const object = expectRecord(value, 'active producer');
  return {
    peerId: expectString(object.peerId, 'active producer peerId'),
    producerId: expectString(object.producerId, 'active producer producerId'),
    appData: expectRecord(object.appData, 'active producer appData') as JsonObject,
    ...(typeof object.retainOnly === 'boolean' ? { retainOnly: object.retainOnly } : {}),
    ...(typeof object.speakerUserId === 'number' || object.speakerUserId === null
      ? { speakerUserId: object.speakerUserId }
      : {}),
    ...(typeof object.speakerName === 'string' || object.speakerName === null
      ? { speakerName: object.speakerName }
      : {}),
    ...(typeof object.speakerKind === 'string' || object.speakerKind === null
      ? { speakerKind: object.speakerKind }
      : {}),
  };
}

function parsePollEvents(value: unknown): BridgePollEventsResponse {
  const object = expectRecord(value, 'poll events response');
  return {
    events: expectArray(object.events, 'events').map(parseControlEvent),
  };
}

export function parseControlEvent(value: unknown): BridgeControlEvent {
  const object = expectRecord(value, 'bridge control event');
  const event = expectString(object.event, 'control event name');
  if (!CONTROL_EVENTS.has(event as BridgeControlEvent['event'])) {
    throw new Error(`Unsupported bridge control event ${event}`);
  }
  return {
    id: expectString(object.id, 'control event id'),
    event: event as BridgeControlEvent['event'],
    payload: expectRecord(object.payload, 'control event payload') as JsonObject,
    at: expectString(object.at, 'control event timestamp'),
  };
}

function parseOk(value: unknown): BridgeOkResponse {
  return { ok: expectBoolean(expectRecord(value, 'response').ok, 'ok') };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a string`);
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function expectTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`${label} must be true`);
  return true;
}

function expectPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function expectPort(value: unknown, label: string): number {
  const port = expectPositiveNumber(value, label);
  if (!Number.isInteger(port) || port > 65_535) throw new Error(`${label} is invalid`);
  return port;
}

function expectPayloadType(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 127
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONTROL_EVENTS = new Set<BridgeControlEvent['event']>([
  'new-producer',
  'producer-closed',
  'consumer-closed',
  'incoming-talk-state',
  'api-talk-command',
  'api-target-audio-command',
  'session-kicked',
]);
