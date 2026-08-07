import { vi } from 'vitest';
import type { TalktomeAccountMapping } from '~/server/services/talktome-bridge-config';
import type {
  BridgeActiveProducer,
  BridgeAnnounceResponse,
  BridgeApi,
  BridgeConsumer,
  BridgeControlEvent,
  BridgeFeedPort,
  BridgeRuntimeConfig,
  BridgeSessionEndpoint,
  BridgeUserPort,
} from '~/server/services/talktome/types';
import type { TalktomeModuleController } from '~/server/services/talktome/module-controller';

export const ACCOUNT_URI = 'sip:studio@example.com';

export function makeMapping(
  overrides: Partial<TalktomeAccountMapping> = {},
): TalktomeAccountMapping {
  const base: TalktomeAccountMapping = {
    enabled: true,
    key: 'studio',
    endpointKind: 'user',
    talktomeUserId: 41,
    target: { type: 'conference', id: 9 },
    ptt: {
      mode: 'audio-level',
      thresholdDb: -45,
      holdMs: 300,
      gpi: 1,
    },
    tally: {
      activeGpo: 2,
      liveGpo: 3,
    },
    mixLocalCallers: true,
    bitrateBps: 64_000,
    previousAudioSource: '',
    previousAudioPlayer: '',
  };
  if (overrides.endpointKind === 'feed') {
    const feed = {
      ...base,
      ...overrides,
      endpointKind: 'feed',
      talktomeFeedId: overrides.talktomeFeedId ?? 3,
      target: null,
      ptt: { ...base.ptt, ...overrides.ptt },
      tally: { ...base.tally, ...overrides.tally },
    } as Record<string, unknown>;
    delete feed.talktomeUserId;
    return feed as TalktomeAccountMapping;
  }
  return {
    ...base,
    ...overrides,
    endpointKind: overrides.endpointKind ?? base.endpointKind,
    target:
      overrides.target === null
        ? null
        : { ...base.target, ...overrides.target },
    ptt: { ...base.ptt, ...overrides.ptt },
    tally: { ...base.tally, ...overrides.tally },
  } as TalktomeAccountMapping;
}

export function makeUserPort(mapping: TalktomeAccountMapping): BridgeUserPort {
  if (mapping.endpointKind !== 'user') {
    throw new Error('makeUserPort requires a user mapping');
  }
  return {
    id: `port-${mapping.talktomeUserId}`,
    kind: 'user',
    userId: mapping.talktomeUserId,
    feedId: null,
    label: mapping.key,
    enabled: true,
    input: { deviceId: 'baresip-sip-tx', leftChannel: 1, rightChannel: 2 },
    output: { deviceId: 'baresip-sip-rx', leftChannel: 1, rightChannel: 2 },
    trigger: {
      mode: mapping.ptt.mode,
      target: { ...mapping.target },
      thresholdDb: mapping.ptt.thresholdDb,
    },
    triggerTargets: [{ ...mapping.target, name: 'Configured target' }],
    updatedAt: null,
  };
}

export function makeFeedPort(mapping: TalktomeAccountMapping): BridgeFeedPort {
  if (mapping.endpointKind !== 'feed') {
    throw new Error('makeFeedPort requires a feed mapping');
  }
  return {
    id: `feed-${mapping.talktomeFeedId}`,
    kind: 'feed',
    userId: null,
    feedId: mapping.talktomeFeedId,
    label: mapping.key,
    enabled: true,
    input: { deviceId: 'baresip-sip-tx', leftChannel: 1, rightChannel: 2 },
    output: null,
    updatedAt: null,
  };
}

export function makeRuntimeConfig(
  mappings: TalktomeAccountMapping[],
): BridgeRuntimeConfig {
  return {
    bridgeId: 'bridge-main',
    revision: 'revision-1',
    ports: mappings.map((mapping) =>
      mapping.endpointKind === 'feed' ? makeFeedPort(mapping) : makeUserPort(mapping),
    ),
  };
}

export function makeActiveProducer(
  producerId: string,
): BridgeActiveProducer {
  return {
    peerId: `peer-${producerId}`,
    producerId,
    appData: { source: 'test' },
    speakerUserId: 77,
    speakerName: 'Remote',
    speakerKind: 'user',
  };
}

export function makeConsumer(producerId: string): BridgeConsumer {
  return {
    id: `consumer-${producerId}`,
    producerId,
    kind: 'audio',
    rtpParameters: {
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: 111,
          clockRate: 48_000,
          channels: 2,
        },
      ],
      encodings: [{ ssrc: 123_456 }],
    },
    transport: {
      ip: '127.0.0.1',
      port: 50_004,
      protocol: 'udp',
      rtcpMux: true,
      comedia: true,
    },
  };
}

interface ControlledStream {
  response: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

function controlledEventStream(): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
    controller,
  };
}

export function makeBridgeHarness(
  mappingsByUri: Record<string, TalktomeAccountMapping>,
  initialActiveProducers: BridgeActiveProducer[] = [],
) {
  const mappingValues = Object.values(mappingsByUri);
  const runtimeConfig = makeRuntimeConfig(mappingValues);
  const streams = new Map<string, ControlledStream>();
  const order: string[] = [];
  let activeProducers = [...initialActiveProducers];

  const announcement: BridgeAnnounceResponse = {
    bridge: {
      id: 'bridge-main',
      name: 'Test bridge',
      platform: 'test',
      host: '127.0.0.1',
      inventory: { host: '127.0.0.1', devices: [] },
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      remoteAddress: null,
      stale: false,
    },
    bridgeToken: 'announced-token',
    config: runtimeConfig,
  };

  const api = {
    announce: vi.fn(async () => announcement),
    getConfig: vi.fn(async () => runtimeConfig),
    putUserEndpoint: vi.fn(async () => runtimeConfig),
    putFeedEndpoint: vi.fn(async () => runtimeConfig),
    createSession: vi.fn(async (_bridgeId: string, endpoint: BridgeSessionEndpoint) => {
      if ('feedId' in endpoint) {
        const mapping = mappingValues.find(
          (candidate) =>
            candidate.endpointKind === 'feed' &&
            candidate.talktomeFeedId === endpoint.feedId,
        );
        if (!mapping) throw new Error(`Unknown test feed ${endpoint.feedId}`);
        return {
          sessionId: `session-feed-${endpoint.feedId}`,
          port: makeFeedPort(mapping),
        };
      }
      const mapping = mappingValues.find(
        (candidate) =>
          candidate.endpointKind === 'user' &&
          candidate.talktomeUserId === endpoint.userId,
      );
      if (!mapping) throw new Error(`Unknown test user ${endpoint.userId}`);
      return {
        sessionId: `session-${endpoint.userId}`,
        port: makeUserPort(mapping),
      };
    }),
    deleteSession: vi.fn(async (sessionId: string) => {
      streams.delete(sessionId);
      return { ok: true };
    }),
    heartbeat: vi.fn(async () => ({ ok: true })),
    pollEvents: vi.fn(async () => []),
    openEventStream: vi.fn(async (sessionId: string) => {
      const stream = controlledEventStream();
      streams.set(sessionId, stream);
      return stream.response;
    }),
    getActiveProducers: vi.fn(async () => [...activeProducers]),
    createPlainSendTransport: vi.fn(async (sessionId: string) => ({
      id: `transport-${sessionId}`,
      ip: '127.0.0.1',
      port: 40_000,
      protocol: 'udp',
      payloadType: 111,
      ssrc: 987_654,
    })),
    createProducer: vi.fn(async (sessionId: string) => ({
      id: `local-${sessionId}`,
    })),
    pauseProducer: vi.fn(async () => ({ ok: true, paused: true })),
    resumeProducer: vi.fn(async () => ({ ok: true, paused: false })),
    setTalkState: vi.fn(async (_sessionId: string, request: { talking: boolean }) => ({
      ok: true,
      talking: request.talking,
      targets: request.talking ? [{ type: 'conference' as const, id: 9 }] : [],
    })),
    createConsumer: vi.fn(async (_sessionId: string, producerId: string) => {
      order.push(`consumer:${producerId}`);
      return makeConsumer(producerId);
    }),
    resumeConsumer: vi.fn(async (_sessionId: string, consumerId: string) => {
      order.push(`resume:${consumerId.replace(/^consumer-/, '')}`);
      return { ok: true };
    }),
    deleteConsumer: vi.fn(async () => ({ ok: true })),
    sendCommandResult: vi.fn(async () => ({ ok: true })),
  };

  const module = {
    openContext: vi.fn(async () => undefined),
    configureContext: vi.fn(async () => undefined),
    closeContext: vi.fn(async () => undefined),
    bindTransmit: vi.fn(async () => undefined),
    setTransmitMuted: vi.fn(async () => undefined),
    reserveSource: vi.fn(async (_key: string, producerId: string) => {
      order.push(`reserve:${producerId}`);
      return { localRecvPort: 51_000 };
    }),
    addSource: vi.fn(async (_key: string, endpoint: { producerId: string }) => {
      order.push(`add:${endpoint.producerId}`);
    }),
    removeSource: vi.fn(async () => undefined),
    getStats: vi.fn(async () => ({ packets: 10 })),
  };

  const mappings = {
    getAccount: vi.fn((uri: string) => mappingsByUri[uri]),
    getEnabledAccounts: vi.fn(
      () =>
        Object.entries(mappingsByUri).filter(([, mapping]) => mapping.enabled) as Array<
          [string, TalktomeAccountMapping]
        >,
    ),
  };

  return {
    api,
    module,
    mappings,
    order,
    setActiveProducers(producers: BridgeActiveProducer[]) {
      activeProducers = [...producers];
    },
    async waitForStream(sessionId: string): Promise<void> {
      for (let attempt = 0; attempt < 50 && !streams.has(sessionId); attempt += 1) {
        await Promise.resolve();
      }
      if (!streams.has(sessionId)) {
        throw new Error(`Event stream ${sessionId} was not opened`);
      }
    },
    emitEvent(sessionId: string, event: BridgeControlEvent): void {
      const stream = streams.get(sessionId);
      if (!stream) throw new Error(`Event stream ${sessionId} is not open`);
      stream.controller.enqueue(
        new TextEncoder().encode(
          `event: bridge-event\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    },
  };
}

export async function flushMicrotasks(turns = 30): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

export function asBridgeApi(value: object): BridgeApi {
  return value as BridgeApi;
}

export function asModule(value: object): TalktomeModuleController {
  return value as TalktomeModuleController;
}
