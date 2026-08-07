import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeEventSubscriber,
  SseParser,
  consumeSseResponse,
} from '~/server/services/talktome/event-stream';
import type {
  BridgeActiveProducer,
  BridgeApi,
  BridgeControlEvent,
} from '~/server/services/talktome/types';

function chunkedResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function controlledResponse(onCancel: (reason: unknown) => void): {
  response: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
  return {
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
    controller,
  };
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SSE parsing and bridge event subscription', () => {
  it('parses arbitrary CRLF boundaries, BOM, comments, multiline data, retry, and EOF', () => {
    const parser = new SseParser();

    expect(parser.push('\uFEFF: heartbeat\r\nid: event-17\r')).toEqual([]);
    expect(
      parser.push(
        '\nevent: custom\r\ndata: first line\r\ndata: second line\r\nretry: 1500\r\n\r\n',
      ),
    ).toEqual([
      {
        event: 'custom',
        data: 'first line\nsecond line',
        id: 'event-17',
        retry: 1500,
      },
    ]);

    expect(parser.push('data: trailing UTF-8 ✓')).toEqual([]);
    expect(parser.finish()).toEqual([
      {
        event: 'message',
        data: 'trailing UTF-8 ✓',
        id: 'event-17',
        retry: 1500,
      },
    ]);
  });

  it('decodes UTF-8 correctly when multi-byte characters cross byte chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      'event: bridge-event\ndata: {"speaker":"Grüße 🎙️"}\n\n',
    );
    const messages: unknown[] = [];

    await consumeSseResponse(
      chunkedResponse([...bytes].map((byte) => Uint8Array.of(byte))),
      (message) => {
        messages.push(message);
      },
    );

    expect(messages).toEqual([
      {
        event: 'bridge-event',
        data: '{"speaker":"Grüße 🎙️"}',
      },
    ]);
  });

  it('rejects an idle SSE stream, cleans up, and rearms its timeout on comment bytes', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = controlledResponse(cancelled);
    const abortController = new AbortController();
    const removeListener = vi.spyOn(
      abortController.signal,
      'removeEventListener',
    );
    const messages: unknown[] = [];
    const consumption = consumeSseResponse(
      stream.response,
      (message) => {
        messages.push(message);
      },
      {
        signal: abortController.signal,
        idleTimeoutMs: 100,
      },
    );
    const settled = consumption.catch((error: unknown) => error);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(99);
    expect(cancelled).not.toHaveBeenCalled();
    stream.controller.enqueue(new TextEncoder().encode(': heartbeat\r\n\r\n'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(99);
    expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const idleError = await settled;
    expect(idleError).toBeInstanceOf(Error);
    expect((idleError as Error).message).toBe(
      'Bridge SSE stream was idle for 100 ms',
    );

    expect(messages).toEqual([]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled.mock.calls[0][0]).toMatchObject({
      message: 'Bridge SSE stream was idle for 100 ms',
    });
    expect(removeListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispatches bridge events once, reconciles producers, and maps session-closed to session-kicked', async () => {
    vi.useFakeTimers();
    const bridgeEvent: BridgeControlEvent = {
      id: 'event-1',
      event: 'new-producer',
      payload: {
        peerId: 'peer-1',
        producerId: 'producer-1',
        appData: {},
      },
      at: '2026-01-01T00:00:00.000Z',
    };
    const streamText = [
      `event: bridge-event\nid: event-1\ndata: ${JSON.stringify(bridgeEvent)}\n\n`,
      `event: bridge-event\nid: event-1\ndata: ${JSON.stringify(bridgeEvent)}\n\n`,
      'event: session-closed\nid: session-end\ndata: {"reason":"replaced"}\n\n',
    ].join('');
    const active: BridgeActiveProducer[] = [
      {
        peerId: 'peer-existing',
        producerId: 'producer-existing',
        appData: {},
      },
    ];
    const api = {
      getActiveProducers: vi.fn(async () => active),
      openEventStream: vi.fn(async () =>
        chunkedResponse([new TextEncoder().encode(streamText)]),
      ),
      pollEvents: vi.fn(async () => []),
    } as unknown as BridgeApi;
    const events: BridgeControlEvent[] = [];
    const reconciliations: BridgeActiveProducer[][] = [];
    const transports: string[] = [];
    let subscriber!: BridgeEventSubscriber;
    subscriber = new BridgeEventSubscriber({
      api,
      sessionId: 'session-1',
      reconcileIntervalMs: 1_000,
      onEvent: async (event) => {
        events.push(event);
        if (event.event === 'session-kicked') subscriber.stop('test-complete');
      },
      onReconcile: (producers) => {
        reconciliations.push(producers);
      },
      onTransportChange: (transport) => {
        transports.push(transport);
      },
    });

    subscriber.start();
    await subscriber.waitUntilStopped();

    expect(reconciliations).toEqual([active]);
    expect(events).toEqual([
      bridgeEvent,
      expect.objectContaining({
        id: 'session-end',
        event: 'session-kicked',
        payload: { reason: 'replaced' },
      }),
    ]);
    expect(api.getActiveProducers).toHaveBeenCalledWith(
      'session-1',
      expect.any(AbortSignal),
    );
    expect(api.pollEvents).not.toHaveBeenCalled();
    // The fallback transport is announced before its abort guard runs.
    expect(transports).toEqual(['sse', 'poll', 'disconnected']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
