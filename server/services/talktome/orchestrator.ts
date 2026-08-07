import {
  isFeedMapping,
  normalizeAccountUri,
  type TalktomeAccountMapping,
} from '../talktome-bridge-config';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  TalktomeBridgePhase,
  TalktomeBridgeStatus,
} from '~/types';
import { BridgeEventSubscriber } from './event-stream';
import {
  usesVirtualBridgeInputDevice,
  usesVirtualBridgeDevices,
  virtualBridgeInputDeviceSelection,
  virtualBridgeDeviceSelection,
} from './virtual-inventory';
import type {
  AccountMappingProvider,
  BridgeActiveProducer,
  BridgeAnnounceRequest,
  BridgeAnnounceResponse,
  BridgeApi,
  BridgeConsumer,
  BridgeControlEvent,
  BridgeIncomingTalkStatePayload,
  BridgeProducerEventPayload,
  BridgeTalkCommandPayload,
  BridgeTargetAudioCommandPayload,
  BridgeFeedEndpointUpdate,
  BridgeUserEndpointUpdate,
  JsonObject,
} from './types';
import type { TalktomeModuleController } from './module-controller';

export type { TalktomeBridgePhase, TalktomeBridgeStatus } from '~/types';

export interface TalktomeTallyUpdate {
  accountUri: string;
  gpo: number;
  active: boolean;
  kind: 'conference-active' | 'producer-live';
}

export interface TalktomeTargetAudioResult {
  ok: boolean;
  reason?: string;
}

export interface TalktomeBridgeOrchestratorCallbacks {
  onStatus?: (status: TalktomeBridgeStatus) => void | Promise<void>;
  onTally?: (update: TalktomeTallyUpdate) => void | Promise<void>;
  onAnnouncement?: (
    announcement: BridgeAnnounceResponse,
  ) => void | Promise<void>;
  onTargetAudioCommand?: (
    accountUri: string,
    command: BridgeTargetAudioCommandPayload,
  ) => TalktomeTargetAudioResult | Promise<TalktomeTargetAudioResult>;
  onError?: (error: unknown, accountUri?: string) => void;
}

export interface TalktomeBridgeOrchestratorOptions {
  enabled: boolean;
  bridgeId: string;
  api: BridgeApi;
  module: TalktomeModuleController;
  mappings: AccountMappingProvider;
  announcement?: BridgeAnnounceRequest;
  autoProvisionEndpoints?: boolean;
  /**
   * How often to re-POST /api/v1/bridge/announce. talktome v1.1.1 marks a
   * bridge stale after ~45s without a fresh announce; the reference bridge
   * client refreshes every 10s.
   */
  announceIntervalMs?: number;
  heartbeatIntervalMs?: number;
  eventPollIntervalMs?: number;
  eventReconcileIntervalMs?: number;
  eventIdleTimeoutMs?: number;
  callbacks?: TalktomeBridgeOrchestratorCallbacks;
}

interface ConsumerBinding {
  producerId: string;
  consumerId: string;
  localRecvPort: number;
}

interface AccountRuntime {
  accountUri: string;
  mapping: TalktomeAccountMapping;
  calls: Set<string>;
  phase: TalktomeBridgePhase;
  queue: Promise<void>;
  contextOpen: boolean;
  sessionId?: string;
  producerId?: string;
  consumers: Map<string, ConsumerBinding>;
  subscriber?: BridgeEventSubscriber;
  eventTransport: 'sse' | 'poll' | 'disconnected';
  heartbeatTimer?: ReturnType<typeof setInterval>;
  vadTimer?: ReturnType<typeof setTimeout>;
  setupRetryTimer?: ReturnType<typeof setTimeout>;
  setupRetryDelayMs: number;
  pttSafetyRetryTimer?: ReturnType<typeof setTimeout>;
  pttSafetyRetryDelayMs: number;
  sessionDeleteRetryTimer?: ReturnType<typeof setTimeout>;
  sessionDeleteRetryDelayMs: number;
  generation: number;
  vadActive: boolean;
  externalPressedCalls: Set<string>;
  apiPressed: boolean;
  locked: boolean;
  pttLive: boolean;
  pttOffPending: boolean;
  pendingTeardownReason?: string;
  teardownCompletion?: Promise<void>;
  resolveTeardownCompletion?: () => void;
  reportedLock: boolean;
  incomingTalkActive: boolean;
  moduleReceiveActive: boolean;
  receiveActiveProducers: Set<string>;
  activeTally: boolean;
  liveTally: boolean;
  lifecycleEvents: Array<{ event: string; detail?: string }>;
  lastError?: string;
  updatedAt: number;
}

/** Matches talktome bridge-client syncManagedBridge interval (v1.1.1). */
const DEFAULT_ANNOUNCE_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const INITIAL_SETUP_RETRY_MS = 2_000;
const MAX_SETUP_RETRY_MS = 30_000;
const INITIAL_PTT_SAFETY_RETRY_MS = 500;
const MAX_PTT_SAFETY_RETRY_MS = 10_000;
const INITIAL_SESSION_DELETE_RETRY_MS = 1_000;
const MAX_SESSION_DELETE_RETRY_MS = 30_000;

/**
 * Per-account control-plane orchestrator. It has no imports from the baresip
 * connection, parser or state manager; callers feed events through the public
 * methods and implement module commands/status/tally through injected ports.
 */
export class TalktomeBridgeOrchestrator {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly announceIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private announceTimer?: ReturnType<typeof setInterval>;
  private announceInFlight?: Promise<void>;
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: TalktomeBridgeOrchestratorOptions) {
    if (!options.bridgeId.trim()) throw new Error('Talktome bridgeId is required');
    this.announceIntervalMs = validateInterval(
      options.announceIntervalMs,
      DEFAULT_ANNOUNCE_INTERVAL_MS,
      1_000,
      60_000,
      'announce interval',
    );
    this.heartbeatIntervalMs = validateInterval(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      1_000,
      120_000,
      'heartbeat interval',
    );
  }

  /**
   * Announces the bridge (when a payload was supplied) and independently
   * validates/provisions every enabled account endpoint.
   */
  async initialize(): Promise<BridgeAnnounceResponse | undefined> {
    if (this.disposed) throw new Error('Talktome bridge orchestrator is disposed');
    if (this.initialized) return undefined;
    if (!this.options.enabled) {
      this.initialized = true;
      return undefined;
    }

    let announcement: BridgeAnnounceResponse | undefined;
    try {
      if (this.options.announcement) {
        if (this.options.announcement.bridgeId !== this.options.bridgeId) {
          throw new Error('Announcement bridgeId does not match orchestrator bridgeId');
        }
        announcement = await this.options.api.announce(this.options.announcement);
        await this.options.callbacks?.onAnnouncement?.(announcement);
      }

      let runtimeConfig =
        announcement?.config ??
        (await this.options.api.getConfig(this.options.bridgeId).catch(() => undefined));
      const enabledMappings = this.options.mappings.getEnabledAccounts?.() ?? [];
      if (runtimeConfig && enabledMappings.length) {
        for (const [rawUri, mapping] of enabledMappings) {
          const accountUri = normalizeAccountUri(rawUri);
          try {
            runtimeConfig = await this.ensureEndpoint(runtimeConfig, mapping);
            if (!isFeedMapping(mapping)) this.assertTargetAllowed(runtimeConfig, mapping);
          } catch (error) {
            const runtime = this.getOrCreateRuntime(accountUri, mapping);
            runtime.phase = 'failed';
            runtime.lastError = errorMessage(error);
            this.reportError(error, accountUri);
            this.emitStatus(runtime);
          }
        }
      }
      if (runtimeConfig) {
        try {
          await this.normalizeEndpointDevices(runtimeConfig);
        } catch (error) {
          this.reportError(error);
        }
      }
      this.initialized = true;
      // talktome v1.1.1 registry liveness is announce-driven (not session SSE).
      this.startAnnounceKeepAlive();
      return announcement;
    } catch (error) {
      this.initialized = false;
      this.clearAnnounceKeepAlive();
      throw error;
    }
  }

  async callEstablished(accountUri: string, callId: string): Promise<void> {
    if (!this.options.enabled || this.disposed) return;
    this.requireInitialized();
    const uri = normalizeAccountUri(accountUri);
    const mapping = this.options.mappings.getAccount(uri);
    if (!mapping?.enabled) return;
    requireCallId(callId);

    const runtime = this.getOrCreateRuntime(uri, mapping);
    await this.enqueue(runtime, async () => {
      if (
        (!runtime.sessionId && !runtime.contextOpen) ||
        !mappingRequiresRestart(runtime.mapping, mapping)
      ) {
        runtime.mapping = mapping;
      }
      const wasPresent = runtime.calls.has(callId);
      runtime.calls.add(callId);
      if (runtime.phase === 'stopping') {
        this.emitStatus(runtime);
        return;
      }
      if (
        runtime.phase === 'connected' ||
        runtime.phase === 'degraded' ||
        runtime.phase === 'starting' ||
        (wasPresent && (runtime.sessionId || runtime.contextOpen))
      ) {
        this.emitStatus(runtime);
        return;
      }
      await this.startRuntime(runtime);
    });
  }

  async callEnded(accountUri: string, callId: string): Promise<void> {
    if (!this.options.enabled) return;
    const uri = normalizeAccountUri(accountUri);
    const runtime = this.runtimes.get(uri);
    if (!runtime) return;
    await this.enqueue(runtime, async () => {
      const normalizedCallId = requireCallId(callId);
      runtime.calls.delete(normalizedCallId);
      const externalChanged =
        runtime.externalPressedCalls.delete(normalizedCallId);
      if (runtime.calls.size === 0) {
        const completed = await this.teardownRuntime(runtime, 'last-call-ended');
        if (completed) {
          const currentMapping = this.options.mappings.getAccount(uri);
          runtime.phase = currentMapping?.enabled ? 'idle' : 'disabled';
          runtime.lastError = undefined;
        }
      } else if (externalChanged) {
        await this.applyDesiredPttSafely(runtime);
      }
      this.emitStatus(runtime);
    });
  }

  async allCallsEnded(accountUri: string): Promise<void> {
    if (!this.options.enabled) return;
    const uri = normalizeAccountUri(accountUri);
    const runtime = this.runtimes.get(uri);
    if (!runtime) return;
    await this.enqueue(runtime, async () => {
      runtime.calls.clear();
      runtime.externalPressedCalls.clear();
      const completed = await this.teardownRuntime(runtime, 'calls-ended');
      if (completed) {
        const currentMapping = this.options.mappings.getAccount(uri);
        runtime.phase = currentMapping?.enabled ? 'idle' : 'disabled';
        runtime.lastError = undefined;
      }
      this.emitStatus(runtime);
    });
  }

  /**
   * Re-reads one mapping after a config change. Existing calls are preserved;
   * resources are torn down or restarted according to the new soft toggle.
   */
  async refreshAccount(accountUri: string): Promise<void> {
    if (!this.options.enabled || this.disposed) return;
    this.requireInitialized();
    const uri = normalizeAccountUri(accountUri);
    const mapping = this.options.mappings.getAccount(uri);
    const runtime = this.runtimes.get(uri);
    if (mapping?.enabled) {
      try {
        let serverConfig = await this.options.api.getConfig(this.options.bridgeId);
        serverConfig = await this.ensureEndpoint(serverConfig, mapping);
        if (!isFeedMapping(mapping)) this.assertTargetAllowed(serverConfig, mapping);
      } catch (error) {
        if (runtime) {
          if (runtime.pendingTeardownReason) runtime.phase = 'stopping';
          else runtime.phase = 'failed';
          runtime.lastError = errorMessage(error);
          this.emitStatus(runtime);
        }
        this.reportError(error, uri);
        throw error;
      }
    }
    if (!runtime) return;
    await this.enqueue(runtime, async () => {
      if (!mapping?.enabled) {
        const completed = await this.teardownRuntime(runtime, 'account-disabled');
        if (!completed) return;
        if (mapping) runtime.mapping = mapping;
        runtime.phase = 'disabled';
        this.emitStatus(runtime);
        return;
      }
      const requiresRestart = mappingRequiresRestart(runtime.mapping, mapping);
      if (requiresRestart && (runtime.sessionId || runtime.contextOpen)) {
        const completed = await this.teardownRuntime(
          runtime,
          'account-mapping-changed',
        );
        if (!completed) return;
      }
      runtime.mapping = mapping;
      if (runtime.calls.size && !runtime.sessionId) await this.startRuntime(runtime);
      else this.emitStatus(runtime);
    });
  }

  async updateVadLevel(
    accountUri: string,
    levelDbfs: number,
    observedAt = Date.now(),
  ): Promise<void> {
    if (!Number.isFinite(levelDbfs)) return;
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    if (
      !runtime ||
      isFeedMapping(runtime.mapping) ||
      runtime.mapping.ptt.mode !== 'audio-level'
    ) {
      return;
    }
    await this.enqueue(runtime, async () => {
      if (!runtime.sessionId || runtime.calls.size === 0) return;
      if (levelDbfs >= runtime.mapping.ptt.thresholdDb) {
        if (runtime.vadTimer) clearTimeout(runtime.vadTimer);
        runtime.vadTimer = undefined;
        runtime.vadActive = true;
        await this.applyDesiredPttSafely(runtime);
        return;
      }
      if (!runtime.vadActive || runtime.vadTimer) return;
      const holdMs = runtime.mapping.ptt.holdMs;
      if (holdMs === 0) {
        runtime.vadActive = false;
        await this.applyDesiredPttSafely(runtime);
        return;
      }
      const dueAt = observedAt + holdMs;
      const generation = runtime.generation;
      const sessionId = runtime.sessionId;
      runtime.vadTimer = setTimeout(() => {
        if (!this.isCurrentSession(runtime, generation, sessionId)) return;
        runtime.vadTimer = undefined;
        void this.enqueue(runtime, async () => {
          if (
            !this.isCurrentSession(runtime, generation, sessionId) ||
            Date.now() < dueAt ||
            runtime.mapping.ptt.mode !== 'audio-level'
          ) {
            return;
          }
          runtime.vadActive = false;
          await this.applyDesiredPttSafely(runtime);
        });
      }, Math.max(0, dueAt - Date.now()));
      runtime.vadTimer.unref?.();
    });
  }

  async setExternalPtt(
    accountUri: string,
    callIdOrPressed: string | boolean,
    pressedForCall?: boolean,
  ): Promise<void> {
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    if (
      !runtime ||
      isFeedMapping(runtime.mapping) ||
      runtime.mapping.ptt.mode !== 'external'
    ) {
      return;
    }
    const legacy = typeof callIdOrPressed === 'boolean';
    const callId = legacy
      ? '__legacy-account-ptt__'
      : requireCallId(callIdOrPressed);
    const pressed = legacy ? callIdOrPressed : pressedForCall;
    if (typeof pressed !== 'boolean') {
      throw new Error('External PTT state must be a boolean');
    }
    await this.enqueue(runtime, async () => {
      if (pressed) runtime.externalPressedCalls.add(callId);
      else runtime.externalPressedCalls.delete(callId);
      await this.applyDesiredPttSafely(runtime);
    });
  }

  /**
   * Optional module telemetry hook for tally when incoming-talk-state is not
   * sufficient (for example, source-level activity).
   */
  async setReceiveActivity(
    accountUri: string,
    producerId: string,
    active: boolean,
  ): Promise<void> {
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    if (!runtime || !producerId) return;
    await this.enqueue(runtime, async () => {
      if (active) runtime.receiveActiveProducers.add(producerId);
      else runtime.receiveActiveProducers.delete(producerId);
      await this.updateActiveTally(runtime);
    });
  }

  async setAggregateReceiveActivity(
    accountUri: string,
    active: boolean,
  ): Promise<void> {
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    if (!runtime) return;
    await this.enqueue(runtime, async () => {
      runtime.moduleReceiveActive = active;
      await this.updateActiveTally(runtime);
    });
  }

  async reportModuleError(accountUri: string, message: string): Promise<void> {
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    if (!runtime || !message) return;
    await this.enqueue(runtime, async () => {
      if (runtime.pendingTeardownReason) runtime.phase = 'stopping';
      else runtime.phase = runtime.sessionId ? 'degraded' : 'failed';
      runtime.lastError = `module: ${message}`;
      this.emitStatus(runtime);
    });
  }

  getStatus(accountUri: string): TalktomeBridgeStatus | undefined {
    const runtime = this.runtimes.get(normalizeAccountUri(accountUri));
    return runtime ? this.snapshot(runtime) : undefined;
  }

  getAllStatuses(): TalktomeBridgeStatus[] {
    return [...this.runtimes.values()].map((runtime) => this.snapshot(runtime));
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAnnounceKeepAlive();
    if (this.announceInFlight) {
      await this.announceInFlight.catch(() => undefined);
    }
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        await this.enqueue(runtime, async () => {
          runtime.calls.clear();
          const completed = await this.teardownRuntime(
            runtime,
            'orchestrator-stopped',
          );
          if (completed) runtime.phase = 'idle';
          this.emitStatus(runtime);
        });
        await runtime.teardownCompletion;
      }),
    );
  }

  /**
   * Keep the bridge registry entry fresh. Session SSE/heartbeat only update
   * control-session liveness; the admin "Bridge Instances" row goes stale
   * unless /announce is refreshed within BRIDGE_REGISTRY_STALE_MS (~45s).
   */
  private startAnnounceKeepAlive(): void {
    if (!this.options.announcement || this.disposed) return;
    this.clearAnnounceKeepAlive();
    this.announceTimer = setInterval(() => {
      void this.refreshAnnouncement();
    }, this.announceIntervalMs);
    this.announceTimer.unref?.();
  }

  private clearAnnounceKeepAlive(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = undefined;
  }

  private async refreshAnnouncement(): Promise<void> {
    if (this.disposed || !this.options.announcement || this.announceInFlight) {
      return;
    }
    const announcement = this.options.announcement;
    this.announceInFlight = (async () => {
      try {
        const response = await this.options.api.announce(announcement);
        await this.options.callbacks?.onAnnouncement?.(response);
      } catch (error) {
        this.reportError(error);
      }
    })();
    try {
      await this.announceInFlight;
    } finally {
      this.announceInFlight = undefined;
    }
  }

  private async startRuntime(runtime: AccountRuntime): Promise<void> {
    // A successful teardown leaves the phase as stopping until its caller
    // chooses the next state. Resources, rather than that transient phase,
    // are the authoritative barrier to starting a replacement.
    if (
      runtime.pendingTeardownReason ||
      runtime.sessionId ||
      runtime.contextOpen
    ) {
      return;
    }
    this.clearSetupRetry(runtime);
    this.clearPttSafetyRetry(runtime);
    runtime.pttSafetyRetryDelayMs = INITIAL_PTT_SAFETY_RETRY_MS;
    const generation = ++runtime.generation;
    runtime.phase = 'starting';
    runtime.lastError = undefined;
    runtime.lifecycleEvents.push({ event: 'session-starting' });
    this.emitStatus(runtime);
    try {
      await this.options.module.openContext(runtime.mapping.key);
      runtime.contextOpen = true;
      await this.options.module.configureContext(runtime.mapping.key, {
        mixLocalCallers: runtime.mapping.mixLocalCallers,
        bitrateBps: runtime.mapping.bitrateBps,
      });

      const feedMapping = isFeedMapping(runtime.mapping);
      const session = await this.options.api.createSession(
        this.options.bridgeId,
        feedMapping
          ? { feedId: runtime.mapping.talktomeFeedId }
          : { userId: runtime.mapping.talktomeUserId },
      );
      runtime.sessionId = session.sessionId;
      if (feedMapping) {
        if (
          session.port.kind !== 'feed' ||
          session.port.feedId !== runtime.mapping.talktomeFeedId
        ) {
          throw new Error(
            `Talktome feed ${runtime.mapping.talktomeFeedId} is not a bridge endpoint`,
          );
        }
      } else if (
        session.port.kind !== 'user' ||
        !session.port.triggerTargets.some(
          (target) =>
            target.type === runtime.mapping.target?.type &&
            target.id === runtime.mapping.target?.id,
        )
      ) {
        throw new Error(
          `Target ${runtime.mapping.target?.type}:${runtime.mapping.target?.id} is not allowed for this bridge endpoint`,
        );
      }
      this.startEventSubscriber(runtime, generation);

      const transport = await this.options.api.createPlainSendTransport(session.sessionId);
      const producer = await this.options.api.createProducer(
        session.sessionId,
        transport.payloadType,
        transport.ssrc,
      );
      runtime.producerId = producer.id;
      const txIp = await resolveMediaEndpointIp(transport.ip);
      await this.options.module.bindTransmit(runtime.mapping.key, {
        ip: txIp,
        port: transport.port,
        payloadType: transport.payloadType,
        ssrc: transport.ssrc,
      });
      await this.options.module.setTransmitMuted(runtime.mapping.key, !feedMapping);

      if (feedMapping) {
        runtime.pttLive = true;
      } else {
        const active = await this.options.api.getActiveProducers(session.sessionId);
        await this.reconcileProducers(runtime, active);
      }
      this.startHeartbeat(runtime, generation);
      runtime.phase = 'connected';
      runtime.setupRetryDelayMs = INITIAL_SETUP_RETRY_MS;
      runtime.lifecycleEvents.push({ event: 'session-connected' });
      this.emitStatus(runtime);
    } catch (error) {
      runtime.lastError = errorMessage(error);
      this.reportError(error, runtime.accountUri);
      const completed = await this.teardownRuntime(runtime, 'setup-failed');
      if (completed) {
        runtime.phase = 'failed';
        this.emitStatus(runtime);
        this.scheduleSetupRetry(runtime);
      }
    }
  }

  private startEventSubscriber(
    runtime: AccountRuntime,
    generation: number,
  ): void {
    if (!runtime.sessionId) return;
    const sessionId = runtime.sessionId;
    let subscriber!: BridgeEventSubscriber;
    subscriber = new BridgeEventSubscriber({
      api: this.options.api,
      sessionId,
      pollIntervalMs: this.options.eventPollIntervalMs,
      reconcileIntervalMs: this.options.eventReconcileIntervalMs,
      sseIdleTimeoutMs: this.options.eventIdleTimeoutMs,
      onEvent: (event) => {
        if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
          return;
        }
        return this.enqueue(runtime, async () => {
          if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
            return;
          }
          await this.handleControlEvent(runtime, event);
        });
      },
      ...(isFeedMapping(runtime.mapping)
        ? {}
        : {
            onReconcile: (active: BridgeActiveProducer[]) => {
              if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
                return;
              }
              return this.enqueue(runtime, async () => {
                if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
                  return;
                }
                await this.reconcileProducers(runtime, active);
              });
            },
          }),
      onError: (error, source) => {
        if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
          return;
        }
        if (runtime.phase === 'stopping' || runtime.phase === 'idle') return;
        void this.enqueue(runtime, async () => {
          if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
            return;
          }
          if (runtime.phase === 'stopping' || runtime.phase === 'idle') return;
          if (await this.recoverAbsentSession(runtime, error, source)) {
            return;
          }
          this.reportError(error, runtime.accountUri);
          if (runtime.phase === 'connected') runtime.phase = 'degraded';
          runtime.lastError = `${source}: ${errorMessage(error)}`;
          this.emitStatus(runtime);
        });
      },
      onTransportChange: (transport) => {
        if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
          return;
        }
        void this.enqueue(runtime, async () => {
          if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
            return;
          }
          runtime.eventTransport = transport;
          this.emitStatus(runtime);
        });
      },
      onTransportLoss: (error) => {
        if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
          return;
        }
        return this.enqueue(runtime, async () => {
          if (!this.isCurrentSession(runtime, generation, sessionId, subscriber)) {
            return;
          }
          await this.handleEventTransportLoss(runtime, error);
        });
      },
    });
    runtime.subscriber = subscriber;
    subscriber.start();
  }

  private async handleControlEvent(
    runtime: AccountRuntime,
    event: BridgeControlEvent,
  ): Promise<void> {
    if (!runtime.sessionId) return;
    const feedMapping = isFeedMapping(runtime.mapping);
    switch (event.event) {
      case 'new-producer': {
        if (feedMapping) break;
        const producer = producerFromPayload(event.payload);
        if (producer && !producer.retainOnly) {
          await this.ensureConsumer(runtime, producer);
        }
        break;
      }
      case 'producer-closed': {
        if (feedMapping) break;
        const producerId = stringProperty(event.payload, 'producerId');
        if (producerId) await this.removeConsumer(runtime, producerId, true);
        break;
      }
      case 'consumer-closed': {
        if (feedMapping) break;
        const consumerId = stringProperty(event.payload, 'consumerId');
        const producerId =
          stringProperty(event.payload, 'producerId') ||
          (consumerId
            ? [...runtime.consumers.values()].find(
                (binding) => binding.consumerId === consumerId,
              )?.producerId
            : undefined);
        if (producerId) {
          const binding = runtime.consumers.get(producerId);
          if (!consumerId || binding?.consumerId === consumerId) {
            runtime.consumers.delete(producerId);
            runtime.receiveActiveProducers.delete(producerId);
            await settle(
              this.options.module.removeSource(runtime.mapping.key, producerId),
              (error) => this.reportError(error, runtime.accountUri),
            );
            await this.updateActiveTally(runtime);
            this.emitStatus(runtime);
          }
        }
        break;
      }
      case 'incoming-talk-state': {
        if (feedMapping) break;
        const payload = event.payload as BridgeIncomingTalkStatePayload;
        runtime.incomingTalkActive = Boolean(payload.state?.addressedNow?.length);
        await this.updateActiveTally(runtime);
        break;
      }
      case 'api-talk-command':
        if (!feedMapping) {
          await this.handleApiTalkCommand(
            runtime,
            event.payload as unknown as BridgeTalkCommandPayload,
          );
        }
        break;
      case 'api-target-audio-command':
        await this.handleTargetAudioCommand(
          runtime,
          event.payload as unknown as BridgeTargetAudioCommandPayload,
        );
        break;
      case 'session-kicked':
        runtime.lastError =
          stringProperty(event.payload, 'reason') || 'Talktome session was kicked';
        if (await this.teardownRuntime(runtime, 'session-kicked')) {
          runtime.phase = 'failed';
          this.emitStatus(runtime);
          this.scheduleSetupRetry(runtime);
        }
        break;
      default:
        break;
    }
  }

  private async reconcileProducers(
    runtime: AccountRuntime,
    activeProducers: BridgeActiveProducer[],
  ): Promise<void> {
    if (!runtime.sessionId) return;
    const activeById = new Map(
      activeProducers
        .filter((producer) => producer.producerId && producer.producerId !== runtime.producerId)
        .map((producer) => [producer.producerId, producer]),
    );

    for (const producer of activeById.values()) {
      // talktome v1.1.1: paused talk producers stay in active-producers with
      // retainOnly so existing consumers survive PTT gaps. Do not create new
      // consumers for those entries (matches official bridge-client).
      if (producer.retainOnly) continue;
      try {
        await this.ensureConsumer(runtime, producer);
      } catch (error) {
        runtime.phase = 'degraded';
        runtime.lastError = `consumer ${producer.producerId}: ${errorMessage(error)}`;
        this.reportError(error, runtime.accountUri);
      }
    }
    for (const producerId of [...runtime.consumers.keys()]) {
      if (!activeById.has(producerId)) await this.removeConsumer(runtime, producerId);
    }
    this.emitStatus(runtime);
  }

  /**
   * Load-bearing reserve-first sequence:
   * module reserve -> HTTP consumer -> module activation/probe -> HTTP resume.
   */
  private async ensureConsumer(
    runtime: AccountRuntime,
    producer: BridgeActiveProducer,
  ): Promise<void> {
    if (!runtime.sessionId || runtime.consumers.has(producer.producerId)) return;
    const producerId = producer.producerId;
    const reservation = await this.options.module.reserveSource(
      runtime.mapping.key,
      producerId,
    );
    let consumer: BridgeConsumer | undefined;
    let moduleSourceAdded = false;
    try {
      consumer = await this.options.api.createConsumer(runtime.sessionId, producerId);
      const opus =
        consumer.rtpParameters.codecs.find(
          (codec) => codec.mimeType.toLowerCase() === 'audio/opus',
        ) ?? consumer.rtpParameters.codecs[0];
      if (!opus) throw new Error('Consumer response contains no RTP codec');
      const ssrc = consumer.rtpParameters.encodings[0]?.ssrc;
      const rxIp = await resolveMediaEndpointIp(consumer.transport.ip);
      await this.options.module.addSource(runtime.mapping.key, {
        producerId,
        ip: rxIp,
        port: consumer.transport.port,
        payloadType: opus.payloadType,
        ...(ssrc === undefined ? {} : { ssrc }),
      });
      moduleSourceAdded = true;
      await this.options.api.resumeConsumer(runtime.sessionId, consumer.id);
      runtime.consumers.set(producerId, {
        producerId,
        consumerId: consumer.id,
        localRecvPort: reservation.localRecvPort,
      });
      runtime.lifecycleEvents.push({
        event: 'consumer-added',
        detail: producerId,
      });
      this.emitStatus(runtime);
    } catch (error) {
      if (consumer) {
        await settle(
          this.options.api.deleteConsumer(runtime.sessionId, consumer.id),
          (cleanupError) => this.reportError(cleanupError, runtime.accountUri),
        );
      }
      if (moduleSourceAdded || reservation.localRecvPort) {
        await settle(
          this.options.module.removeSource(runtime.mapping.key, producerId),
          (cleanupError) => this.reportError(cleanupError, runtime.accountUri),
        );
      }
      throw error;
    }
  }

  private async removeConsumer(
    runtime: AccountRuntime,
    producerId: string,
    serverAlreadyClosed = false,
  ): Promise<void> {
    const binding = runtime.consumers.get(producerId);
    runtime.consumers.delete(producerId);
    runtime.receiveActiveProducers.delete(producerId);
    const operations: Promise<unknown>[] = [
      this.options.module.removeSource(runtime.mapping.key, producerId),
    ];
    if (binding && runtime.sessionId && !serverAlreadyClosed) {
      operations.push(
        this.options.api.deleteConsumer(runtime.sessionId, binding.consumerId),
      );
    }
    const results = await Promise.allSettled(operations);
    for (const result of results) {
      if (result.status === 'rejected') this.reportError(result.reason, runtime.accountUri);
    }
    await this.updateActiveTally(runtime);
    this.emitStatus(runtime);
  }

  private async handleApiTalkCommand(
    runtime: AccountRuntime,
    command: BridgeTalkCommandPayload,
  ): Promise<void> {
    const commandId = command.commandId;
    const previousApiPressed = runtime.apiPressed;
    const previousLocked = runtime.locked;
    let attemptedDesiredOn: boolean | undefined;
    let result: { ok: boolean; reason?: string } = { ok: true };
    try {
      if (!['press', 'release', 'lock-toggle'].includes(command.action)) {
        throw new Error('Unsupported talk command action');
      }
      if (
        command.targetType &&
        command.targetType !== 'reply' &&
        (command.targetType !== runtime.mapping.target?.type ||
          command.targetId !== runtime.mapping.target?.id)
      ) {
        throw new Error('Requested talk target is not configured for this account');
      }
      const attemptedApiPressed =
        command.action === 'press'
          ? true
          : command.action === 'release'
            ? false
            : previousApiPressed;
      const attemptedLocked =
        command.action === 'lock-toggle' ? !previousLocked : previousLocked;
      attemptedDesiredOn = this.desiredPtt(
        runtime,
        attemptedApiPressed,
        attemptedLocked,
      );
      runtime.apiPressed = attemptedApiPressed;
      runtime.locked = attemptedLocked;
      await this.applyDesiredPtt(runtime);
    } catch (error) {
      // Rejecting an attempted ON state also rejects this command as a future
      // activation source. A close-only rollback retry may still run, but it
      // can then reopen only for sources that existed independently.
      if (attemptedDesiredOn) {
        runtime.apiPressed = previousApiPressed;
        runtime.locked = previousLocked;
      }
      result = { ok: false, reason: errorMessage(error) };
      this.reportError(error, runtime.accountUri);
    }
    if (commandId && runtime.sessionId) {
      await settle(
        this.options.api.sendCommandResult(runtime.sessionId, {
          commandId,
          ok: result.ok,
          action: command.action,
          ...(command.targetType ? { targetType: command.targetType } : {}),
          ...(command.targetId === undefined ? {} : { targetId: command.targetId }),
          ...(result.reason ? { reason: result.reason } : {}),
        }),
        (error) => this.reportError(error, runtime.accountUri),
      );
    }
  }

  private async handleTargetAudioCommand(
    runtime: AccountRuntime,
    command: BridgeTargetAudioCommandPayload,
  ): Promise<void> {
    let result: TalktomeTargetAudioResult;
    try {
      result = this.options.callbacks?.onTargetAudioCommand
        ? await this.options.callbacks.onTargetAudioCommand(runtime.accountUri, command)
        : { ok: false, reason: 'target-audio-command-not-supported' };
      if (!result || typeof result.ok !== 'boolean') {
        throw new Error('Target audio callback returned an invalid result');
      }
    } catch (error) {
      result = { ok: false, reason: errorMessage(error) };
      this.reportError(error, runtime.accountUri);
    }
    if (command.commandId && runtime.sessionId) {
      await settle(
        this.options.api.sendCommandResult(runtime.sessionId, {
          commandId: command.commandId,
          ok: result.ok,
          action: command.action,
          targetType: command.targetType,
          targetId: command.targetId,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
        (error) => this.reportError(error, runtime.accountUri),
      );
    }
  }

  private async applyDesiredPttSafely(runtime: AccountRuntime): Promise<void> {
    try {
      await this.applyDesiredPtt(runtime);
    } catch (error) {
      runtime.phase = 'degraded';
      runtime.lastError = `PTT: ${errorMessage(error)}`;
      this.reportError(error, runtime.accountUri);
      this.emitStatus(runtime);
    }
  }

  private async applyDesiredPtt(runtime: AccountRuntime): Promise<void> {
    if (
      isFeedMapping(runtime.mapping) ||
      runtime.phase === 'stopping' ||
      !runtime.sessionId ||
      !runtime.producerId
    ) {
      return;
    }
    const desired = this.desiredPtt(runtime);
    if (runtime.pttOffPending) {
      await this.applyPttOff(runtime, false);
      if (!desired) return;
    }
    if (desired === runtime.pttLive) {
      if (
        desired &&
        runtime.reportedLock !== runtime.locked &&
        runtime.sessionId
      ) {
        await this.options.api.setTalkState(runtime.sessionId, {
          talking: true,
          targets: runtime.mapping.target ? [runtime.mapping.target] : [],
          lockActive: runtime.locked,
        });
        runtime.reportedLock = runtime.locked;
        this.emitStatus(runtime);
      }
      return;
    }

    if (desired) {
      try {
        await this.options.module.setTransmitMuted(runtime.mapping.key, false);
        const producerState = await this.options.api.resumeProducer(
          runtime.sessionId,
          runtime.producerId,
        );
        if (!producerState.ok || producerState.paused) {
          throw new Error('Talktome server did not confirm producer resume');
        }
        const talkState = await this.options.api.setTalkState(runtime.sessionId, {
          talking: true,
          targets: runtime.mapping.target ? [runtime.mapping.target] : [],
          lockActive: runtime.locked,
        });
        if (!talkState.ok || !talkState.talking) {
          throw new Error('Talktome server did not confirm talk-state true');
        }
        runtime.pttLive = true;
        runtime.pttOffPending = false;
        runtime.reportedLock = runtime.locked;
      } catch (error) {
        try {
          await this.applyPttOff(runtime, false);
        } catch (rollbackError) {
          this.reportError(rollbackError, runtime.accountUri);
        }
        throw error;
      }
    } else {
      await this.applyPttOff(runtime, runtime.locked);
      return;
    }
    await this.updateLiveTally(runtime);
    this.emitStatus(runtime);
  }

  private desiredPtt(
    runtime: AccountRuntime,
    apiPressed = runtime.apiPressed,
    locked = runtime.locked,
  ): boolean {
    const sourcePressed =
      runtime.mapping.ptt.mode === 'audio-level'
        ? runtime.vadActive
        : runtime.externalPressedCalls.size > 0;
    return locked || apiPressed || sourcePressed;
  }

  private async applyPttOff(
    runtime: AccountRuntime,
    lockActive: boolean,
  ): Promise<void> {
    if (isFeedMapping(runtime.mapping) || !runtime.sessionId || !runtime.producerId) return;
    const sessionId = runtime.sessionId;
    const producerId = runtime.producerId;
    const [moduleMuteResult, talkStateResult, producerPauseResult] =
      await Promise.allSettled([
        this.options.module.setTransmitMuted(runtime.mapping.key, true),
        this.options.api
          .setTalkState(sessionId, {
            talking: false,
            targets: [],
            lockActive,
          })
          .then((state) => {
            if (!state.ok || state.talking) {
              throw new Error('Talktome server did not confirm talk-state false');
            }
          }),
        this.options.api.pauseProducer(sessionId, producerId).then((state) => {
          if (!state.ok || !state.paused) {
            throw new Error('Talktome server did not confirm producer pause');
          }
        }),
      ]);
    const sessionAbsent = [talkStateResult, producerPauseResult].some(
      (result) =>
        result.status === 'rejected' && isSessionAbsentError(result.reason),
    );
    const failures: unknown[] = [];
    if (moduleMuteResult.status === 'rejected') {
      failures.push(moduleMuteResult.reason);
    }
    if (!sessionAbsent) {
      if (talkStateResult.status === 'rejected') {
        failures.push(talkStateResult.reason);
      }
      if (producerPauseResult.status === 'rejected') {
        failures.push(producerPauseResult.reason);
      }
    }
    if (failures.length) {
      runtime.pttLive = true;
      runtime.pttOffPending = true;
      if (runtime.phase !== 'stopping') runtime.phase = 'degraded';
      const failure = combinedError('PTT safety gate failed', failures);
      runtime.lastError = `PTT safety gate: ${errorMessage(failure)}`;
      this.schedulePttSafetyRetry(runtime);
      await this.updateLiveTally(runtime);
      this.emitStatus(runtime);
      throw failure;
    }
    this.clearPttSafetyRetry(runtime);
    runtime.pttSafetyRetryDelayMs = INITIAL_PTT_SAFETY_RETRY_MS;
    runtime.pttLive = false;
    runtime.pttOffPending = false;
    runtime.reportedLock = false;
    await this.updateLiveTally(runtime);
    this.emitStatus(runtime);
  }

  private schedulePttSafetyRetry(runtime: AccountRuntime): void {
    if (
      runtime.pttSafetyRetryTimer ||
      !runtime.sessionId ||
      !runtime.producerId
    ) {
      return;
    }
    const generation = runtime.generation;
    const sessionId = runtime.sessionId;
    const producerId = runtime.producerId;
    const delay = runtime.pttSafetyRetryDelayMs;
    runtime.pttSafetyRetryDelayMs = Math.min(
      MAX_PTT_SAFETY_RETRY_MS,
      Math.max(INITIAL_PTT_SAFETY_RETRY_MS, delay * 2),
    );
    runtime.pttSafetyRetryTimer = setTimeout(() => {
      runtime.pttSafetyRetryTimer = undefined;
      if (
        runtime.generation !== generation ||
        runtime.sessionId !== sessionId ||
        runtime.producerId !== producerId
      ) {
        return;
      }
      void this.enqueue(runtime, async () => {
        if (
          runtime.generation !== generation ||
          runtime.sessionId !== sessionId ||
          runtime.producerId !== producerId
        ) {
          return;
        }
        try {
          await this.applyPttOff(runtime, false);
          // Only a still-desired, independently accepted source may open PTT
          // after the close-only safety retry has completed.
          if (this.desiredPtt(runtime)) await this.applyDesiredPtt(runtime);
        } catch (error) {
          // applyPttOff records the error and schedules the next bounded retry.
          this.reportError(error, runtime.accountUri);
        }
      });
    }, delay);
    runtime.pttSafetyRetryTimer.unref?.();
  }

  private clearPttSafetyRetry(runtime: AccountRuntime): void {
    if (runtime.pttSafetyRetryTimer) clearTimeout(runtime.pttSafetyRetryTimer);
    runtime.pttSafetyRetryTimer = undefined;
  }

  private async failClosedApiPtt(
    runtime: AccountRuntime,
    cause: unknown,
  ): Promise<void> {
    runtime.apiPressed = false;
    runtime.locked = false;
    runtime.phase = 'degraded';
    runtime.lastError = `event transport lost: ${errorMessage(cause)}`;
    try {
      await this.applyPttOff(runtime, false);
    } catch (error) {
      runtime.lastError = `event transport lost; PTT safety retry pending: ${errorMessage(
        error,
      )}`;
      this.reportError(error, runtime.accountUri);
    }
    this.emitStatus(runtime);
  }

  private async handleEventTransportLoss(
    runtime: AccountRuntime,
    cause: unknown,
  ): Promise<void> {
    if (await this.recoverAbsentSession(runtime, cause, 'event transport')) {
      return;
    }
    if (!isFeedMapping(runtime.mapping)) {
      await this.failClosedApiPtt(runtime, cause);
      return;
    }
    runtime.phase = 'degraded';
    runtime.lastError = `event transport lost: ${errorMessage(cause)}`;
    this.emitStatus(runtime);
  }

  private startHeartbeat(runtime: AccountRuntime, generation: number): void {
    if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
    const sessionId = runtime.sessionId;
    runtime.heartbeatTimer = setInterval(() => {
      if (!this.isCurrentSession(runtime, generation, sessionId)) return;
      void this.enqueue(runtime, async () => {
        if (!this.isCurrentSession(runtime, generation, sessionId)) return;
        await this.sendHeartbeat(runtime);
      });
    }, this.heartbeatIntervalMs);
    runtime.heartbeatTimer.unref?.();
  }

  private async sendHeartbeat(runtime: AccountRuntime): Promise<void> {
    if (!runtime.sessionId) return;
    let moduleStats: JsonObject | null = null;
    try {
      moduleStats = await this.options.module.getStats(runtime.mapping.key);
    } catch (error) {
      this.reportError(error, runtime.accountUri);
    }
    const lifecycleEvents = runtime.lifecycleEvents.slice(-20);
    try {
      await this.options.api.heartbeat(runtime.sessionId, {
        mediaDiagnostics: { module: moduleStats },
        lifecycleEvents,
      });
      if (lifecycleEvents.length) {
        runtime.lifecycleEvents.splice(
          Math.max(0, runtime.lifecycleEvents.length - lifecycleEvents.length),
          lifecycleEvents.length,
        );
      }
      if (runtime.phase === 'degraded' && !runtime.pttOffPending) {
        runtime.phase = 'connected';
        runtime.lastError = undefined;
        this.emitStatus(runtime);
      }
    } catch (error) {
      if (await this.recoverAbsentSession(runtime, error, 'heartbeat')) {
        return;
      }
      runtime.phase = 'degraded';
      runtime.lastError = `heartbeat: ${errorMessage(error)}`;
      this.reportError(error, runtime.accountUri);
      this.emitStatus(runtime);
    }
  }

  /**
   * TalkToMe wiped the control session (container restart, TTL, etc.). Tear
   * down local bridge state and recreate while the SIP call stays up — same
   * recovery shape as `session-kicked`, without waiting for a call cycle.
   */
  private async recoverAbsentSession(
    runtime: AccountRuntime,
    cause: unknown,
    source: string,
  ): Promise<boolean> {
    if (!isSessionAbsentError(cause)) return false;
    if (
      runtime.phase === 'stopping' ||
      runtime.phase === 'starting' ||
      runtime.phase === 'idle'
    ) {
      return true;
    }
    if (!runtime.sessionId && !runtime.contextOpen) {
      if (runtime.calls.size > 0) this.scheduleSetupRetry(runtime);
      return true;
    }

    runtime.lastError = `${source}: ${errorMessage(cause)}; recreating session`;
    this.reportError(cause, runtime.accountUri);
    if (await this.teardownRuntime(runtime, 'session-absent')) {
      runtime.phase = runtime.calls.size > 0 ? 'failed' : 'idle';
      this.emitStatus(runtime);
      this.scheduleSetupRetry(runtime);
    }
    return true;
  }

  private async teardownRuntime(
    runtime: AccountRuntime,
    reason: string,
  ): Promise<boolean> {
    if (runtime.pendingTeardownReason && runtime.sessionId) {
      runtime.phase = 'stopping';
      this.scheduleSessionDeleteRetry(runtime);
      this.emitStatus(runtime);
      return false;
    }
    runtime.generation += 1;
    const hadResources = Boolean(runtime.sessionId || runtime.contextOpen);
    if (hadResources) runtime.phase = 'stopping';
    this.emitStatus(runtime);
    if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
    if (runtime.vadTimer) clearTimeout(runtime.vadTimer);
    this.clearSetupRetry(runtime);
    this.clearPttSafetyRetry(runtime);
    this.clearSessionDeleteRetry(runtime);
    runtime.heartbeatTimer = undefined;
    runtime.vadTimer = undefined;
    runtime.subscriber?.stop(reason);
    runtime.subscriber = undefined;
    runtime.eventTransport = 'disconnected';

    const sessionId = runtime.sessionId;
    const producerId = runtime.producerId;
    if (sessionId && producerId && !isFeedMapping(runtime.mapping)) {
      try {
        await this.applyPttOff(runtime, false);
      } catch (error) {
        // The safety gate owns its independent retry until deleteSession below
        // confirms that this generation has ended.
        this.reportError(error, runtime.accountUri);
      }
    }
    for (const producer of [...runtime.consumers.keys()]) {
      await this.removeConsumer(runtime, producer);
    }
    if (sessionId) {
      try {
        await this.deleteSessionOnce(sessionId, reason);
      } catch (error) {
        this.reportError(error, runtime.accountUri);
        runtime.phase = 'stopping';
        runtime.pendingTeardownReason = reason;
        runtime.vadActive = false;
        runtime.externalPressedCalls.clear();
        runtime.apiPressed = false;
        runtime.locked = false;
        runtime.lastError = `session deletion failed; retry pending: ${errorMessage(
          error,
        )}`;
        this.ensureTeardownCompletion(runtime);
        this.scheduleSessionDeleteRetry(runtime);
        this.emitStatus(runtime);
        return false;
      }
    }
    this.clearSessionDeleteRetry(runtime);
    runtime.sessionDeleteRetryDelayMs = INITIAL_SESSION_DELETE_RETRY_MS;
    this.clearPttSafetyRetry(runtime);
    await this.closeContextAndReset(runtime);
    return true;
  }

  private async deleteSessionOnce(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    try {
      const result = await this.options.api.deleteSession(sessionId, reason);
      if (!result.ok) {
        throw new Error('Talktome server did not confirm session deletion');
      }
    } catch (error) {
      if (isSessionAbsentError(error)) return;
      throw error;
    }
  }

  private scheduleSessionDeleteRetry(runtime: AccountRuntime): void {
    if (
      runtime.sessionDeleteRetryTimer ||
      !runtime.sessionId ||
      !runtime.pendingTeardownReason
    ) {
      return;
    }
    const generation = runtime.generation;
    const sessionId = runtime.sessionId;
    const reason = runtime.pendingTeardownReason;
    const delay = runtime.sessionDeleteRetryDelayMs;
    runtime.sessionDeleteRetryDelayMs = Math.min(
      MAX_SESSION_DELETE_RETRY_MS,
      Math.max(INITIAL_SESSION_DELETE_RETRY_MS, delay * 2),
    );
    runtime.sessionDeleteRetryTimer = setTimeout(() => {
      runtime.sessionDeleteRetryTimer = undefined;
      if (
        runtime.generation !== generation ||
        runtime.sessionId !== sessionId ||
        runtime.pendingTeardownReason !== reason
      ) {
        return;
      }
      void this.enqueue(runtime, async () => {
        if (
          runtime.generation !== generation ||
          runtime.sessionId !== sessionId ||
          runtime.pendingTeardownReason !== reason
        ) {
          return;
        }
        try {
          await this.deleteSessionOnce(sessionId, reason);
        } catch (error) {
          runtime.phase = 'stopping';
          runtime.lastError = `session deletion failed; retry pending: ${errorMessage(
            error,
          )}`;
          this.reportError(error, runtime.accountUri);
          this.scheduleSessionDeleteRetry(runtime);
          this.emitStatus(runtime);
          return;
        }

        this.clearSessionDeleteRetry(runtime);
        runtime.sessionDeleteRetryDelayMs = INITIAL_SESSION_DELETE_RETRY_MS;
        this.clearPttSafetyRetry(runtime);
        await this.closeContextAndReset(runtime);
        const mapping = this.options.mappings.getAccount(runtime.accountUri);
        if (runtime.calls.size > 0 && mapping?.enabled && !this.disposed) {
          runtime.mapping = mapping;
          await this.startRuntime(runtime);
          return;
        }
        runtime.phase = mapping?.enabled ? 'idle' : 'disabled';
        runtime.lastError = undefined;
        this.emitStatus(runtime);
      });
    }, delay);
    runtime.sessionDeleteRetryTimer.unref?.();
  }

  private clearSessionDeleteRetry(runtime: AccountRuntime): void {
    if (runtime.sessionDeleteRetryTimer) {
      clearTimeout(runtime.sessionDeleteRetryTimer);
    }
    runtime.sessionDeleteRetryTimer = undefined;
  }

  private async closeContextAndReset(runtime: AccountRuntime): Promise<void> {
    if (runtime.contextOpen) {
      await settle(
        this.options.module.closeContext(runtime.mapping.key),
        (error) => this.reportError(error, runtime.accountUri),
      );
    }

    runtime.contextOpen = false;
    runtime.sessionId = undefined;
    runtime.producerId = undefined;
    runtime.consumers.clear();
    runtime.receiveActiveProducers.clear();
    runtime.vadActive = false;
    runtime.externalPressedCalls.clear();
    runtime.apiPressed = false;
    runtime.locked = false;
    runtime.pttLive = false;
    runtime.pttOffPending = false;
    runtime.pendingTeardownReason = undefined;
    runtime.reportedLock = false;
    runtime.incomingTalkActive = false;
    runtime.moduleReceiveActive = false;
    await this.updateActiveTally(runtime);
    await this.updateLiveTally(runtime);
    runtime.resolveTeardownCompletion?.();
    runtime.teardownCompletion = undefined;
    runtime.resolveTeardownCompletion = undefined;
  }

  private ensureTeardownCompletion(runtime: AccountRuntime): void {
    if (runtime.teardownCompletion) return;
    runtime.teardownCompletion = new Promise<void>((resolve) => {
      runtime.resolveTeardownCompletion = resolve;
    });
  }

  private async updateActiveTally(runtime: AccountRuntime): Promise<void> {
    if (isFeedMapping(runtime.mapping)) return;
    const active =
      runtime.incomingTalkActive ||
      runtime.moduleReceiveActive ||
      runtime.receiveActiveProducers.size > 0;
    if (active === runtime.activeTally) return;
    runtime.activeTally = active;
    const gpo = runtime.mapping.tally.activeGpo;
    if (gpo !== undefined) {
      await this.emitTally({
        accountUri: runtime.accountUri,
        gpo,
        active,
        kind: 'conference-active',
      });
    }
  }

  private async updateLiveTally(runtime: AccountRuntime): Promise<void> {
    if (isFeedMapping(runtime.mapping)) return;
    if (runtime.pttLive === runtime.liveTally) return;
    runtime.liveTally = runtime.pttLive;
    const gpo = runtime.mapping.tally.liveGpo;
    if (gpo !== undefined) {
      await this.emitTally({
        accountUri: runtime.accountUri,
        gpo,
        active: runtime.liveTally,
        kind: 'producer-live',
      });
    }
  }

  private async emitTally(update: TalktomeTallyUpdate): Promise<void> {
    try {
      await this.options.callbacks?.onTally?.(update);
    } catch (error) {
      this.reportError(error, update.accountUri);
    }
  }

  /**
   * Point every user/feed endpoint on this bridge at the announced virtual SIP
   * devices. Admin "Device missing" is raised for any assigned endpoint whose
   * device IDs are absent from inventory — including endpoints not yet mapped
   * in baresipui.
   */
  private async normalizeEndpointDevices(
    config: Awaited<ReturnType<BridgeApi['getConfig']>>,
  ): Promise<Awaited<ReturnType<BridgeApi['getConfig']>>> {
    if (this.options.autoProvisionEndpoints === false) return config;
    let current = config;
    for (const port of config.ports) {
      if (port.kind === 'user') {
        if (usesVirtualBridgeDevices(port)) continue;
        current = await this.options.api.putUserEndpoint(
          this.options.bridgeId,
          port.userId,
          {
            triggerMode: port.trigger.mode,
            triggerTargetType: port.trigger.target?.type ?? '',
            triggerTargetId: port.trigger.target?.id ?? null,
            triggerThresholdDb: port.trigger.thresholdDb,
            ...virtualBridgeDeviceSelection(),
          },
        );
        continue;
      }
      if (usesVirtualBridgeInputDevice(port)) continue;
      current = await this.options.api.putFeedEndpoint(
        this.options.bridgeId,
        port.feedId,
        virtualBridgeInputDeviceSelection(),
      );
    }
    return current;
  }

  private async ensureEndpoint(
    config: Awaited<ReturnType<BridgeApi['getConfig']>>,
    mapping: TalktomeAccountMapping,
  ): Promise<Awaited<ReturnType<BridgeApi['getConfig']>>> {
    if (isFeedMapping(mapping)) {
      const existing = config.ports.find(
        (port) => port.kind === 'feed' && port.feedId === mapping.talktomeFeedId,
      );
      if (existing && usesVirtualBridgeInputDevice(existing)) {
        return config;
      }
      if (this.options.autoProvisionEndpoints === false && !existing) {
        throw new Error(
          `Talktome feed ${mapping.talktomeFeedId} is not assigned to bridge ${this.options.bridgeId}`,
        );
      }
      if (this.options.autoProvisionEndpoints === false) {
        return config;
      }

      const update: BridgeFeedEndpointUpdate = virtualBridgeInputDeviceSelection();
      return this.options.api.putFeedEndpoint(
        this.options.bridgeId,
        mapping.talktomeFeedId,
        update,
      );
    }

    const existing = config.ports.find(
      (port) => port.kind === 'user' && port.userId === mapping.talktomeUserId,
    );
    const triggerMatches =
      existing?.kind === 'user' &&
      existing.trigger.mode === mapping.ptt.mode &&
      existing.trigger.thresholdDb === mapping.ptt.thresholdDb &&
      existing.trigger.target?.type === mapping.target?.type &&
      existing.trigger.target?.id === mapping.target?.id;
    const devicesMatch =
      existing?.kind === 'user' && usesVirtualBridgeDevices(existing);

    if (triggerMatches && devicesMatch) {
      return config;
    }
    if (this.options.autoProvisionEndpoints === false && !existing) {
      throw new Error(
        `Talktome user ${mapping.talktomeUserId} is not assigned to bridge ${this.options.bridgeId}`,
      );
    }
    if (this.options.autoProvisionEndpoints === false) {
      if (!triggerMatches) {
        throw new Error(
          `Talktome user ${mapping.talktomeUserId} endpoint trigger configuration does not match the account mapping`,
        );
      }
      // Leave manually chosen devices alone when auto-provision is off.
      return config;
    }

    const update: BridgeUserEndpointUpdate = {
      triggerMode: mapping.ptt.mode,
      triggerTargetType: mapping.target?.type ?? '',
      triggerTargetId: mapping.target?.id ?? null,
      triggerThresholdDb: mapping.ptt.thresholdDb,
      ...virtualBridgeDeviceSelection(),
    };
    return this.options.api.putUserEndpoint(
      this.options.bridgeId,
      mapping.talktomeUserId,
      update,
    );
  }

  private assertTargetAllowed(
    config: Awaited<ReturnType<BridgeApi['getConfig']>>,
    mapping: TalktomeAccountMapping,
  ): void {
    if (isFeedMapping(mapping)) return;
    const port = config.ports.find(
      (candidate) =>
        candidate.kind === 'user' && candidate.userId === mapping.talktomeUserId,
    );
    if (!port || port.kind !== 'user') {
      throw new Error(`Talktome user ${mapping.talktomeUserId} is not a bridge endpoint`);
    }
    if (
      !port.triggerTargets.some(
        (target) =>
          target.type === mapping.target?.type && target.id === mapping.target?.id,
      )
    ) {
      throw new Error(
        `Target ${mapping.target?.type}:${mapping.target?.id} is not allowed for talktome user ${mapping.talktomeUserId}`,
      );
    }
  }

  private getOrCreateRuntime(
    accountUri: string,
    mapping: TalktomeAccountMapping,
  ): AccountRuntime {
    const existing = this.runtimes.get(accountUri);
    if (existing) return existing;
    const runtime: AccountRuntime = {
      accountUri,
      mapping,
      calls: new Set(),
      phase: mapping.enabled ? 'idle' : 'disabled',
      queue: Promise.resolve(),
      contextOpen: false,
      consumers: new Map(),
      eventTransport: 'disconnected',
      setupRetryDelayMs: INITIAL_SETUP_RETRY_MS,
      pttSafetyRetryDelayMs: INITIAL_PTT_SAFETY_RETRY_MS,
      sessionDeleteRetryDelayMs: INITIAL_SESSION_DELETE_RETRY_MS,
      generation: 0,
      vadActive: false,
      externalPressedCalls: new Set(),
      apiPressed: false,
      locked: false,
      pttLive: false,
      pttOffPending: false,
      reportedLock: false,
      incomingTalkActive: false,
      moduleReceiveActive: false,
      receiveActiveProducers: new Set(),
      activeTally: false,
      liveTally: false,
      lifecycleEvents: [],
      updatedAt: Date.now(),
    };
    this.runtimes.set(accountUri, runtime);
    return runtime;
  }

  private scheduleSetupRetry(runtime: AccountRuntime): void {
    if (
      this.disposed ||
      runtime.setupRetryTimer ||
      runtime.calls.size === 0
    ) {
      return;
    }
    const mapping = this.options.mappings.getAccount(runtime.accountUri);
    if (!mapping?.enabled) return;
    runtime.mapping = mapping;
    const generation = runtime.generation;
    const delay = runtime.setupRetryDelayMs;
    runtime.setupRetryDelayMs = Math.min(
      MAX_SETUP_RETRY_MS,
      Math.max(INITIAL_SETUP_RETRY_MS, delay * 2),
    );
    runtime.setupRetryTimer = setTimeout(() => {
      if (
        this.disposed ||
        runtime.generation !== generation ||
        runtime.calls.size === 0
      ) {
        return;
      }
      runtime.setupRetryTimer = undefined;
      void this.enqueue(runtime, async () => {
        if (
          this.disposed ||
          runtime.generation !== generation ||
          runtime.calls.size === 0 ||
          runtime.sessionId ||
          runtime.contextOpen
        ) {
          return;
        }
        const current = this.options.mappings.getAccount(runtime.accountUri);
        if (!current?.enabled) return;
        runtime.mapping = current;
        await this.startRuntime(runtime);
      });
    }, delay);
    runtime.setupRetryTimer.unref?.();
  }

  private clearSetupRetry(runtime: AccountRuntime): void {
    if (runtime.setupRetryTimer) clearTimeout(runtime.setupRetryTimer);
    runtime.setupRetryTimer = undefined;
  }

  private isCurrentSession(
    runtime: AccountRuntime,
    generation: number,
    sessionId: string | undefined,
    subscriber?: BridgeEventSubscriber,
  ): boolean {
    return (
      !this.disposed &&
      runtime.generation === generation &&
      runtime.sessionId === sessionId &&
      (subscriber === undefined || runtime.subscriber === subscriber)
    );
  }

  private enqueue<T>(runtime: AccountRuntime, operation: () => Promise<T>): Promise<T> {
    const result = runtime.queue.then(operation, operation);
    runtime.queue = result.then(
      () => undefined,
      (error) => {
        runtime.lastError = errorMessage(error);
        this.reportError(error, runtime.accountUri);
      },
    );
    return result;
  }

  private emitStatus(runtime: AccountRuntime): void {
    runtime.updatedAt = Date.now();
    const status = this.snapshot(runtime);
    try {
      const result = this.options.callbacks?.onStatus?.(status);
      void Promise.resolve(result).catch((error) =>
        this.reportError(error, runtime.accountUri),
      );
    } catch (error) {
      this.reportError(error, runtime.accountUri);
    }
  }

  private snapshot(runtime: AccountRuntime): TalktomeBridgeStatus {
    return {
      accountUri: runtime.accountUri,
      key: runtime.mapping.key,
      phase: runtime.phase,
      activeCallIds: [...runtime.calls],
      ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
      ...(runtime.producerId ? { producerId: runtime.producerId } : {}),
      consumerCount: runtime.consumers.size,
      pttLive: runtime.pttLive,
      pttLocked: runtime.locked,
      eventTransport: runtime.eventTransport,
      ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
      updatedAt: runtime.updatedAt,
    };
  }

  private reportError(error: unknown, accountUri?: string): void {
    try {
      this.options.callbacks?.onError?.(error, accountUri);
    } catch {
      // Error observers must not affect SIP or bridge lifecycle.
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error('Talktome bridge orchestrator must be initialized first');
    }
  }
}

function producerFromPayload(payload: JsonObject): BridgeActiveProducer | undefined {
  const producerId = stringProperty(payload, 'producerId');
  const peerId = stringProperty(payload, 'peerId');
  if (!producerId || !peerId) return undefined;
  const typed = payload as unknown as BridgeProducerEventPayload;
  return {
    peerId,
    producerId,
    appData:
      typed.appData && typeof typed.appData === 'object' && !Array.isArray(typed.appData)
        ? typed.appData
        : {},
    ...(typeof typed.retainOnly === 'boolean'
      ? { retainOnly: typed.retainOnly }
      : {}),
    ...(typed.speakerUserId === null || typeof typed.speakerUserId === 'number'
      ? { speakerUserId: typed.speakerUserId }
      : {}),
    ...(typed.speakerName === null || typeof typed.speakerName === 'string'
      ? { speakerName: typed.speakerName }
      : {}),
    ...(typed.speakerKind === null || typeof typed.speakerKind === 'string'
      ? { speakerKind: typed.speakerKind }
      : {}),
  };
}

function mappingRequiresRestart(
  previous: TalktomeAccountMapping,
  next: TalktomeAccountMapping,
): boolean {
  return (
    previous.key !== next.key ||
    previous.endpointKind !== next.endpointKind ||
    previous.talktomeUserId !== next.talktomeUserId ||
    previous.talktomeFeedId !== next.talktomeFeedId ||
    previous.target?.type !== next.target?.type ||
    previous.target?.id !== next.target?.id ||
    previous.mixLocalCallers !== next.mixLocalCallers ||
    previous.bitrateBps !== next.bitrateBps ||
    previous.ptt.mode !== next.ptt.mode ||
    previous.ptt.thresholdDb !== next.ptt.thresholdDb ||
    previous.ptt.holdMs !== next.ptt.holdMs ||
    previous.ptt.gpi !== next.ptt.gpi
  );
}

function stringProperty(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value ? value : undefined;
}

function requireCallId(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('callId is required');
  return value.trim();
}

function validateInterval(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} ms`);
  }
  return result;
}

async function settle(
  promise: Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    onError(error);
  }
}

function combinedError(message: string, errors: unknown[]): Error {
  const detail = errors.map(errorMessage).join('; ');
  const combined = new Error(detail ? `${message}: ${detail}` : message) as Error & {
    errors: unknown[];
  };
  combined.errors = errors;
  return combined;
}

/**
 * mediasoup_bridge ctrl_tcp commands take a single IP token. Hostnames that
 * fail DNS inside the container previously surfaced as opaque
 * `invalid-tx-endpoint` from the C module.
 */
async function resolveMediaEndpointIp(ipOrHost: string): Promise<string> {
  if (typeof ipOrHost !== 'string' || !ipOrHost.trim()) {
    throw new Error('Talktome media endpoint address is empty');
  }
  const trimmed = ipOrHost.trim();
  if (isIP(trimmed)) return trimmed;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (isIP(inner)) return inner;
  }
  try {
    const resolved = await dnsLookup(trimmed);
    return resolved.address;
  } catch (error) {
    throw new Error(
      `Cannot resolve talktome media endpoint "${trimmed}": ${errorMessage(error)}. ` +
        'Set the talktome server announced/public media address to a routable IP ' +
        'reachable from this host.',
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionAbsentError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  if (
    [candidate.status, candidate.statusCode, candidate.response?.status].some(
      (status) => status === 404 || status === '404',
    )
  ) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /session not found/i.test(candidate.message)
  );
}
