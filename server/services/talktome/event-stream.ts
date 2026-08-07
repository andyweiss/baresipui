import { parseControlEvent } from './http-client';
import type {
  BridgeActiveProducer,
  BridgeApi,
  BridgeControlEvent,
} from './types';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface BridgeEventSubscriberOptions {
  api: BridgeApi;
  sessionId: string;
  onEvent: (event: BridgeControlEvent) => void | Promise<void>;
  onReconcile?: (activeProducers: BridgeActiveProducer[]) => void | Promise<void>;
  onError?: (error: unknown, source: 'sse' | 'poll' | 'reconcile' | 'handler') => void;
  onTransportChange?: (transport: 'sse' | 'poll' | 'disconnected') => void;
  onTransportLoss?: (error: unknown) => void | Promise<void>;
  pollIntervalMs?: number;
  pollFallbackMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconcileIntervalMs?: number;
  sseIdleTimeoutMs?: number;
  maxEventBytes?: number;
  maxRememberedEventIds?: number;
}

/**
 * Incremental WHATWG SSE parser. It handles arbitrary UTF-8 chunk and line
 * boundaries, CRLF, comments, multiline data, retry fields and EOF dispatch.
 */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private lastEventId: string | undefined;
  private retry: number | undefined;
  private eventBytes = 0;
  private firstLine = true;

  constructor(private readonly maxEventBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1_024) {
      throw new Error('SSE maxEventBytes must be an integer of at least 1024');
    }
  }

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes && !this.buffer.includes('\n')) {
      throw new Error('SSE line exceeds configured size limit');
    }

    const messages: SseMessage[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const message = this.processLine(line);
      if (message) messages.push(message);
    }
    if (this.buffer.length > this.maxEventBytes) {
      throw new Error('SSE line exceeds configured size limit');
    }
    return messages;
  }

  finish(): SseMessage[] {
    const messages: SseMessage[] = [];
    if (this.buffer) {
      let line = this.buffer;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const message = this.processLine(line);
      if (message) messages.push(message);
    }
    const finalMessage = this.dispatch();
    if (finalMessage) messages.push(finalMessage);
    return messages;
  }

  private processLine(line: string): SseMessage | undefined {
    if (this.firstLine) {
      this.firstLine = false;
      if (line.startsWith('\uFEFF')) line = line.slice(1);
    }
    if (!line) return this.dispatch();
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.eventBytes += line.length;
    if (this.eventBytes > this.maxEventBytes) {
      throw new Error('SSE event exceeds configured size limit');
    }

    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      case 'retry': {
        const parsed = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(parsed)) this.retry = parsed;
        break;
      }
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    if (!this.dataLines.length) {
      this.eventName = '';
      this.eventBytes = 0;
      return undefined;
    }
    const message: SseMessage = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      ...(this.lastEventId === undefined ? {} : { id: this.lastEventId }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.eventName = '';
    this.dataLines = [];
    this.eventBytes = 0;
    return message;
  }
}

export async function consumeSseResponse(
  response: Response,
  onMessage: (message: SseMessage) => void | Promise<void>,
  options: {
    signal?: AbortSignal;
    maxEventBytes?: number;
    idleTimeoutMs?: number;
  } = {},
): Promise<void> {
  if (!response.body) throw new Error('SSE response has no readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(options.maxEventBytes);
  const idleTimeoutMs = boundedInterval(
    options.idleTimeoutMs,
    60_000,
    100,
    300_000,
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleError: Error | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleError = new Error(
        `Bridge SSE stream was idle for ${idleTimeoutMs} ms`,
      );
      void reader.cancel(idleError).catch(() => undefined);
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });

  try {
    armIdleTimer();
    while (true) {
      const { done, value } = await reader.read();
      if (idleError) throw idleError;
      if (done) break;
      if (value.byteLength > 0) armIdleTimer();
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        await onMessage(message);
      }
    }
    const trailingText = decoder.decode();
    const messages = [
      ...(trailingText ? parser.push(trailingText) : []),
      ...parser.finish(),
    ];
    for (const message of messages) await onMessage(message);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Maintains the native-fetch SSE connection, falls back to event polling after
 * failures, and periodically reconciles against the authoritative active
 * producer wrapper to repair missed or duplicated control events.
 */
export class BridgeEventSubscriber {
  private readonly controller = new AbortController();
  private readonly pollIntervalMs: number;
  private readonly pollFallbackMs: number;
  private reconnectDelayMs: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly sseIdleTimeoutMs: number;
  private readonly maxEventBytes: number;
  private readonly maxRememberedEventIds: number;
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private running = false;
  private runPromise: Promise<void> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private reconcilePromise: Promise<void> | undefined;

  constructor(private readonly options: BridgeEventSubscriberOptions) {
    if (!options.sessionId.trim()) throw new Error('Bridge event sessionId is required');
    this.pollIntervalMs = boundedInterval(options.pollIntervalMs, 1_000, 100, 60_000);
    this.pollFallbackMs = boundedInterval(options.pollFallbackMs, 5_000, 0, 300_000);
    this.initialReconnectDelayMs = boundedInterval(
      options.reconnectDelayMs,
      1_000,
      100,
      60_000,
    );
    this.reconnectDelayMs = this.initialReconnectDelayMs;
    this.maxReconnectDelayMs = boundedInterval(
      options.maxReconnectDelayMs,
      30_000,
      this.initialReconnectDelayMs,
      300_000,
    );
    this.reconcileIntervalMs = boundedInterval(
      options.reconcileIntervalMs,
      30_000,
      1_000,
      300_000,
    );
    this.sseIdleTimeoutMs = boundedInterval(
      options.sseIdleTimeoutMs,
      60_000,
      100,
      300_000,
    );
    this.maxEventBytes = boundedInterval(
      options.maxEventBytes,
      1_048_576,
      1_024,
      16_777_216,
    );
    this.maxRememberedEventIds = boundedInterval(
      options.maxRememberedEventIds,
      2_000,
      100,
      100_000,
    );
  }

  start(): void {
    if (this.running) return;
    if (this.controller.signal.aborted) {
      throw new Error('A stopped BridgeEventSubscriber cannot be restarted');
    }
    this.running = true;
    if (this.options.onReconcile) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcile();
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
    this.runPromise = this.run().finally(() => {
      this.running = false;
      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
      this.options.onTransportChange?.('disconnected');
    });
  }

  stop(reason = 'bridge-event-subscriber-stopped'): void {
    if (!this.controller.signal.aborted) this.controller.abort(new Error(reason));
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  async waitUntilStopped(): Promise<void> {
    await this.runPromise;
  }

  async reconcileNow(): Promise<void> {
    await this.reconcile();
  }

  private async run(): Promise<void> {
    await this.reconcile();
    while (!this.controller.signal.aborted) {
      try {
        this.options.onTransportChange?.('sse');
        const response = await this.options.api.openEventStream(
          this.options.sessionId,
          this.controller.signal,
        );
        this.reconnectDelayMs = this.initialReconnectDelayMs;
        await consumeSseResponse(
          response,
          async (message) => {
            if (message.retry !== undefined) {
              this.reconnectDelayMs = Math.min(
                this.maxReconnectDelayMs,
                Math.max(100, message.retry),
              );
            }
            await this.handleSseMessage(message);
          },
          {
            signal: this.controller.signal,
            maxEventBytes: this.maxEventBytes,
            idleTimeoutMs: this.sseIdleTimeoutMs,
          },
        );
        if (!this.controller.signal.aborted) {
          throw new Error('Bridge SSE stream ended unexpectedly');
        }
      } catch (error) {
        if (this.controller.signal.aborted || isAbortError(error)) break;
        try {
          await this.options.onTransportLoss?.(error);
        } catch (handlerError) {
          this.options.onError?.(handlerError, 'handler');
        }
        this.options.onError?.(error, 'sse');
      }

      await this.reconcile();
      await this.pollFallback();
      if (this.controller.signal.aborted) break;
      await abortableDelay(this.reconnectDelayMs, this.controller.signal);
      this.reconnectDelayMs = Math.min(
        this.maxReconnectDelayMs,
        Math.max(this.initialReconnectDelayMs, this.reconnectDelayMs * 2),
      );
    }
  }

  private async pollFallback(): Promise<void> {
    const until = Date.now() + this.pollFallbackMs;
    this.options.onTransportChange?.('poll');
    do {
      if (this.controller.signal.aborted) return;
      try {
        const events = await this.options.api.pollEvents(
          this.options.sessionId,
          this.controller.signal,
        );
        for (const event of events) await this.dispatch(event);
      } catch (error) {
        if (this.controller.signal.aborted || isAbortError(error)) return;
        this.options.onError?.(error, 'poll');
      }
      if (Date.now() >= until) return;
      await abortableDelay(this.pollIntervalMs, this.controller.signal);
    } while (!this.controller.signal.aborted);
  }

  private async handleSseMessage(message: SseMessage): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(message.data) as unknown;
    } catch (error) {
      throw new Error(`Bridge SSE event contains invalid JSON: ${errorMessage(error)}`);
    }

    if (message.event === 'session-closed') {
      const reason =
        isRecord(decoded) && typeof decoded.reason === 'string'
          ? decoded.reason
          : 'session-closed';
      await this.dispatch({
        id: message.id || `session-closed:${Date.now()}`,
        event: 'session-kicked',
        payload: { reason },
        at: new Date().toISOString(),
      });
      return;
    }
    if (message.event !== 'bridge-event' && message.event !== 'message') return;
    await this.dispatch(parseControlEvent(decoded));
  }

  private async dispatch(event: BridgeControlEvent): Promise<void> {
    if (this.seenEventIds.has(event.id)) return;
    this.remember(event.id);
    try {
      await this.options.onEvent(event);
    } catch (error) {
      this.options.onError?.(error, 'handler');
    }
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    while (this.seenEventOrder.length > this.maxRememberedEventIds) {
      const expired = this.seenEventOrder.shift();
      if (expired) this.seenEventIds.delete(expired);
    }
  }

  private reconcile(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (!this.options.onReconcile) return Promise.resolve();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      try {
        const active = await this.options.api.getActiveProducers(
          this.options.sessionId,
          this.controller.signal,
        );
        await this.options.onReconcile(active);
      } catch (error) {
        if (!this.controller.signal.aborted && !isAbortError(error)) {
          this.options.onError?.(error, 'reconcile');
        }
      }
    })().finally(() => {
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }
}

function boundedInterval(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`Interval must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
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
