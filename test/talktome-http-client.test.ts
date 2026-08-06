import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeHttpError,
  TalktomeBridgeHttpClient,
  normalizeTalktomeBaseUrl,
} from '~/server/services/talktome/http-client';
import { makeFeedPort, makeMapping, makeUserPort } from './helpers/talktome';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit | undefined): unknown {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

describe('TalktomeBridgeHttpClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('normalizes base URLs and rejects unsafe URL/token/timeout inputs', () => {
    expect(normalizeTalktomeBaseUrl(' bridge.example.test/api/ ')).toBe(
      'https://bridge.example.test/api',
    );
    expect(() => normalizeTalktomeBaseUrl('ftp://bridge.example.test')).toThrow(
      'HTTPS or HTTP',
    );
    expect(() => normalizeTalktomeBaseUrl('https://user:pass@example.test')).toThrow(
      'without credentials',
    );
    expect(() => normalizeTalktomeBaseUrl('https://example.test?q=1')).toThrow(
      'query or fragment',
    );
    expect(
      () =>
        new TalktomeBridgeHttpClient({
          baseUrl: 'https://example.test',
          token: 'bad\nheader',
          fetch: vi.fn(),
        }),
    ).toThrow('invalid characters');
  });

  it('announces at the exact path/body with bearer auth and adopts the returned token', async () => {
    const mapping = makeMapping();
    const config = {
      bridgeId: 'bridge-main',
      revision: 'r1',
      ports: [makeUserPort(mapping)],
    };
    const announceBody = {
      bridgeId: 'bridge-main',
      name: 'baresipui',
      platform: 'linux',
      inventory: { host: '192.0.2.4', devices: [] },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          bridge: { id: 'bridge-main', name: 'baresipui' },
          bridgeToken: 'session-token',
          config,
          ignored: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ...config, ignored: true }));
    const client = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.example.test/root/',
      token: 'bootstrap-token',
      fetch: fetchMock as typeof fetch,
    });

    const announced = await client.announce(announceBody);
    const fetchedConfig = await client.getConfig('bridge/main');

    expect(announced).toEqual({
      bridge: { id: 'bridge-main', name: 'baresipui' },
      bridgeToken: 'session-token',
      config,
    });
    expect(fetchedConfig).toEqual(config);

    const [announceUrl, announceInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(announceUrl).toBe(
      'https://bridge.example.test/root/api/v1/bridge/announce',
    );
    expect(announceInit.method).toBe('POST');
    expect(bodyOf(announceInit)).toEqual(announceBody);
    expect(new Headers(announceInit.headers).get('authorization')).toBe(
      'Bearer bootstrap-token',
    );
    expect(new Headers(announceInit.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(announceInit.cache).toBe('no-store');

    const [configUrl, configInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(configUrl).toBe(
      'https://bridge.example.test/root/api/v1/bridge/bridge%2Fmain/config',
    );
    expect(configInit.method).toBe('GET');
    expect(configInit.body).toBeUndefined();
    expect(new Headers(configInit.headers).get('authorization')).toBe(
      'Bearer session-token',
    );
  });

  it('captures optional appVersion from announce and health responses', async () => {
    const mapping = makeMapping();
    const config = {
      bridgeId: 'bridge-main',
      revision: 'r1',
      ports: [makeUserPort(mapping)],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          bridge: { id: 'bridge-main', name: 'baresipui' },
          bridgeToken: 'session-token',
          config,
          appVersion: 'v1.1.4',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          serverStartedAt: '2026-08-02T00:00:00.000Z',
          appVersion: '1.1.5',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          serverStartedAt: '2026-08-02T00:00:00.000Z',
        }),
      );
    const client = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.example.test',
      token: 'token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.announce({
        bridgeId: 'bridge-main',
        platform: 'linux',
        inventory: { host: '192.0.2.4', devices: [] },
      }),
    ).resolves.toMatchObject({ appVersion: '1.1.4' });
    await expect(client.getHealth()).resolves.toEqual({
      ok: true,
      serverStartedAt: '2026-08-02T00:00:00.000Z',
      appVersion: '1.1.5',
    });
    await expect(client.getHealth()).resolves.toEqual({
      ok: true,
      serverStartedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://bridge.example.test/api/v1/health',
    );
  });

  it('requires the active-producer wrapper and sends the consumer handshake with API-key auth', async () => {
    const producer = {
      peerId: 'peer-1',
      producerId: 'producer/1',
      appData: { role: 'speaker' },
      retainOnly: false,
      speakerUserId: 77,
      speakerName: 'Remote',
      speakerKind: 'user',
      ignored: 'not copied',
    };
    const consumer = {
      id: 'consumer-1',
      producerId: 'producer/1',
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
        rtcp: { cname: 'remote' },
      },
      transport: {
        ip: '127.0.0.1',
        port: 50_004,
        protocol: 'udp',
        rtcpMux: true,
        comedia: true,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ producers: [producer] }))
      .mockResolvedValueOnce(jsonResponse(consumer));
    const client = new TalktomeBridgeHttpClient({
      baseUrl: 'http://bridge.test',
      token: 'api-key-value',
      authMode: 'api-key',
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.getActiveProducers('session / one')).resolves.toEqual([
      {
        peerId: 'peer-1',
        producerId: 'producer/1',
        appData: { role: 'speaker' },
        retainOnly: false,
        speakerUserId: 77,
        speakerName: 'Remote',
        speakerKind: 'user',
      },
    ]);
    await expect(
      client.createConsumer('session / one', 'producer/1'),
    ).resolves.toEqual(consumer);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://bridge.test/api/v1/bridge/sessions/session%20%2F%20one/active-producers',
    );
    const activeHeaders = new Headers(
      (fetchMock.mock.calls[0][1] as RequestInit).headers,
    );
    expect(activeHeaders.get('x-api-key')).toBe('api-key-value');
    expect(activeHeaders.has('authorization')).toBe(false);

    const [consumerUrl, consumerInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(consumerUrl).toBe(
      'http://bridge.test/api/v1/bridge/sessions/session%20%2F%20one/consumers',
    );
    expect(consumerInit.method).toBe('POST');
    expect(bodyOf(consumerInit)).toEqual({
      producerId: 'producer/1',
      rtpHandshake: true,
    });
  });

  it('uses exact session, producer, talk-state, and deletion paths and bodies', async () => {
    const mapping = makeMapping();
    const responses = [
      { sessionId: 'session-1', port: makeUserPort(mapping) },
      {
        id: 'transport-1',
        ip: '127.0.0.1',
        port: 40_000,
        protocol: 'udp',
        payloadType: 111,
        ssrc: 999,
      },
      { id: 'producer-1' },
      { ok: true, paused: false },
      {
        ok: true,
        talking: true,
        targets: [{ type: 'conference', id: 9 }],
      },
      { ok: true },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(responses.shift()));
    const client = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.test',
      token: 'token',
      fetch: fetchMock as typeof fetch,
    });

    await client.createSession('bridge-main', { userId: 41 });
    await client.createPlainSendTransport('session-1');
    await client.createProducer('session-1', 111, 999);
    await client.resumeProducer('session-1', 'producer/1');
    await client.setTalkState('session-1', {
      talking: true,
      targets: [{ type: 'conference', id: 9 }],
      lockActive: false,
    });
    await client.deleteSession('session-1', 'last-call-ended');

    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        (init as RequestInit).method,
        url,
        bodyOf(init as RequestInit),
      ]),
    ).toEqual([
      [
        'POST',
        'https://bridge.test/api/v1/bridge/sessions',
        { bridgeId: 'bridge-main', userId: 41 },
      ],
      [
        'POST',
        'https://bridge.test/api/v1/bridge/sessions/session-1/plain-send-transport',
        {},
      ],
      [
        'POST',
        'https://bridge.test/api/v1/bridge/sessions/session-1/producers',
        { payloadType: 111, ssrc: 999 },
      ],
      [
        'POST',
        'https://bridge.test/api/v1/bridge/sessions/session-1/producers/producer%2F1/resume',
        {},
      ],
      [
        'POST',
        'https://bridge.test/api/v1/bridge/sessions/session-1/talk-state',
        {
          talking: true,
          targets: [{ type: 'conference', id: 9 }],
          lockActive: false,
        },
      ],
      [
        'DELETE',
        'https://bridge.test/api/v1/bridge/sessions/session-1',
        { reason: 'last-call-ended' },
      ],
    ]);
  });

  it('creates feed sessions with feedId request bodies', async () => {
    const feedMapping = makeMapping({
      endpointKind: 'feed',
      key: 'feed-3',
      talktomeFeedId: 3,
      target: null,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sessionId: 'session-feed-3', port: makeFeedPort(feedMapping) }),
    );
    const client = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.test',
      token: 'token',
      fetch: fetchMock as typeof fetch,
    });

    await client.createSession('bridge-main', { feedId: 3 });

    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit)).toEqual({
      bridgeId: 'bridge-main',
      feedId: 3,
    });
  });

  it('surfaces HTTP and response-shape failures as structured BridgeHttpError values', async () => {
    const unavailableFetch = vi.fn(async () =>
      jsonResponse({ error: 'temporarily unavailable', detail: 7 }, 503),
    );
    const unavailableClient = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.test',
      token: 'token',
      fetch: unavailableFetch as typeof fetch,
    });

    const unavailable = await unavailableClient
      .getConfig('bridge-main')
      .catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(BridgeHttpError);
    expect(unavailable).toMatchObject({
      method: 'GET',
      url: 'https://bridge.test/api/v1/bridge/bridge-main/config',
      status: 503,
      retryable: true,
      responseBody: { error: 'temporarily unavailable', detail: 7 },
      message: 'Bridge API GET failed: temporarily unavailable',
    });

    const invalidClient = new TalktomeBridgeHttpClient({
      baseUrl: 'https://bridge.test',
      token: 'token',
      fetch: vi.fn(async () => jsonResponse([])) as typeof fetch,
    });
    const invalid = await invalidClient
      .getActiveProducers('session-1')
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(BridgeHttpError);
    expect(invalid).toMatchObject({
      status: 200,
      retryable: false,
      responseBody: [],
    });
    expect((invalid as Error).message).toContain(
      'active producers response must be an object',
    );
  });
});
