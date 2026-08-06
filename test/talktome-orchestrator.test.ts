import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TalktomeBridgeOrchestrator,
  type TalktomeBridgeOrchestratorCallbacks,
} from '~/server/services/talktome/orchestrator';
import type {
  BridgeControlEvent,
  BridgeControlEventName,
  JsonObject,
} from '~/server/services/talktome/types';
import {
  ACCOUNT_URI,
  asBridgeApi,
  asModule,
  flushMicrotasks,
  makeActiveProducer,
  makeBridgeHarness,
  makeMapping,
} from './helpers/talktome';
import {
  VIRTUAL_BRIDGE_INPUT_ID,
  VIRTUAL_BRIDGE_OUTPUT_ID,
  buildVirtualBridgeInventory,
} from '~/server/services/talktome/virtual-inventory';

const orchestrators: TalktomeBridgeOrchestrator[] = [];

function event(
  id: string,
  name: BridgeControlEventName,
  payload: JsonObject,
): BridgeControlEvent {
  return {
    id,
    event: name,
    payload,
    at: '2026-01-01T00:00:00.000Z',
  };
}

function createOrchestrator(
  harness: ReturnType<typeof makeBridgeHarness>,
  callbacks: TalktomeBridgeOrchestratorCallbacks = {},
  enabled = true,
  intervals: {
    heartbeatIntervalMs?: number;
    eventPollIntervalMs?: number;
    eventReconcileIntervalMs?: number;
  } = {},
): TalktomeBridgeOrchestrator {
  const orchestrator = new TalktomeBridgeOrchestrator({
    enabled,
    bridgeId: 'bridge-main',
    api: asBridgeApi(harness.api),
    module: asModule(harness.module),
    mappings: harness.mappings,
    heartbeatIntervalMs: intervals.heartbeatIntervalMs ?? 120_000,
    eventPollIntervalMs: intervals.eventPollIntervalMs ?? 1_000,
    eventReconcileIntervalMs: intervals.eventReconcileIntervalMs ?? 1_000,
    callbacks,
  });
  orchestrators.push(orchestrator);
  return orchestrator;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(async () => {
  await Promise.all(orchestrators.splice(0).map((orchestrator) => orchestrator.stop()));
  await flushMicrotasks();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('TalktomeBridgeOrchestrator', () => {
  it('re-announces on the keep-alive interval so the bridge registry stays fresh', async () => {
    const mapping = makeMapping();
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const announcement = {
      bridgeId: 'bridge-main',
      name: 'baresipui',
      platform: 'test',
      inventory: { host: '127.0.0.1', devices: [] },
    };
    const orchestrator = new TalktomeBridgeOrchestrator({
      enabled: true,
      bridgeId: 'bridge-main',
      api: asBridgeApi(harness.api),
      module: asModule(harness.module),
      mappings: harness.mappings,
      announcement,
      announceIntervalMs: 10_000,
      heartbeatIntervalMs: 120_000,
      eventPollIntervalMs: 1_000,
      eventReconcileIntervalMs: 1_000,
    });
    orchestrators.push(orchestrator);

    await orchestrator.initialize();
    expect(harness.api.announce).toHaveBeenCalledTimes(1);
    expect(harness.api.announce).toHaveBeenCalledWith(announcement);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.api.announce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.api.announce).toHaveBeenCalledTimes(2);
    expect(harness.api.announce).toHaveBeenLastCalledWith(announcement);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.api.announce).toHaveBeenCalledTimes(4);

    await orchestrator.stop();
    harness.api.announce.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.api.announce).not.toHaveBeenCalled();
  });

  it('forwards announce responses so runtime can refresh bridge user ports', async () => {
    const mapping = makeMapping();
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const announcements: Array<{ revision: string }> = [];
    const announcement = {
      bridgeId: 'bridge-main',
      name: 'baresipui',
      platform: 'test',
      inventory: { host: '127.0.0.1', devices: [] },
    };
    const orchestrator = new TalktomeBridgeOrchestrator({
      enabled: true,
      bridgeId: 'bridge-main',
      api: asBridgeApi(harness.api),
      module: asModule(harness.module),
      mappings: harness.mappings,
      announcement,
      announceIntervalMs: 10_000,
      heartbeatIntervalMs: 120_000,
      eventPollIntervalMs: 1_000,
      eventReconcileIntervalMs: 1_000,
      callbacks: {
        onAnnouncement: (response) => {
          announcements.push({ revision: response.config.revision });
        },
      },
    });
    orchestrators.push(orchestrator);

    await orchestrator.initialize();
    expect(announcements).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(announcements).toHaveLength(2);
  });

  it('auto-provisions virtual SIP devices so talktome Admin does not report Device missing', async () => {
    const mapping = makeMapping();
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const stalePort = {
      id: 'port-41',
      kind: 'user' as const,
      userId: 41,
      feedId: null,
      label: '41',
      enabled: true,
      input: { deviceId: '', leftChannel: 0, rightChannel: 0 },
      output: { deviceId: 'win-speakers', leftChannel: 1, rightChannel: 2 },
      trigger: {
        mode: mapping.ptt.mode,
        target: { ...mapping.target },
        thresholdDb: mapping.ptt.thresholdDb,
      },
      triggerTargets: [{ ...mapping.target, name: 'Configured target' }],
      updatedAt: null,
    };
    const staleConfig = {
      bridgeId: 'bridge-main',
      revision: 'revision-stale-devices',
      ports: [stalePort],
    };
    // initialize() prefers announcement.config over a separate getConfig call.
    harness.api.announce.mockResolvedValue({
      bridge: {
        id: 'bridge-main',
        name: 'BareSIP-Bridge',
        platform: 'test',
        host: '172.19.0.8',
        inventory: buildVirtualBridgeInventory('172.19.0.8'),
        connectedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        remoteAddress: null,
        stale: false,
      },
      bridgeToken: 'announced-token',
      config: staleConfig,
    });
    const inventory = buildVirtualBridgeInventory('172.19.0.8');
    const orchestrator = new TalktomeBridgeOrchestrator({
      enabled: true,
      bridgeId: 'bridge-main',
      api: asBridgeApi(harness.api),
      module: asModule(harness.module),
      mappings: harness.mappings,
      announcement: {
        bridgeId: 'bridge-main',
        name: 'BareSIP-Bridge',
        platform: 'test',
        inventory,
      },
      heartbeatIntervalMs: 120_000,
      eventPollIntervalMs: 1_000,
      eventReconcileIntervalMs: 1_000,
    });
    orchestrators.push(orchestrator);

    await orchestrator.initialize();

    expect(harness.api.announce).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: expect.objectContaining({
          host: '172.19.0.8',
          devices: expect.arrayContaining([
            expect.objectContaining({
              id: VIRTUAL_BRIDGE_INPUT_ID,
              direction: 'input',
              max_channels: 2,
            }),
            expect.objectContaining({
              id: VIRTUAL_BRIDGE_OUTPUT_ID,
              direction: 'output',
              max_channels: 2,
            }),
          ]),
        }),
      }),
    );
    expect(harness.api.putUserEndpoint).toHaveBeenCalledWith(
      'bridge-main',
      41,
      expect.objectContaining({
        inputDevice: VIRTUAL_BRIDGE_INPUT_ID,
        inputLeftChannel: 1,
        inputRightChannel: 2,
        outputDevice: VIRTUAL_BRIDGE_OUTPUT_ID,
        outputLeftChannel: 1,
        outputRightChannel: 2,
      }),
    );
  });

  it('creates one session on the first concurrent call and tears it down only after the last call', async () => {
    const mapping = makeMapping();
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();

    await Promise.all([
      orchestrator.callEstablished(ACCOUNT_URI, 'call-1'),
      orchestrator.callEstablished(ACCOUNT_URI, 'call-2'),
      orchestrator.callEstablished(ACCOUNT_URI, 'call-1'),
    ]);

    expect(harness.module.openContext).toHaveBeenCalledTimes(1);
    expect(harness.api.createSession).toHaveBeenCalledTimes(1);
    expect(harness.api.createSession).toHaveBeenCalledWith('bridge-main', {
      userId: 41,
    });
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      activeCallIds: ['call-1', 'call-2'],
      sessionId: 'session-41',
      producerId: 'local-session-41',
    });

    await orchestrator.callEnded(ACCOUNT_URI, 'call-1');
    expect(harness.api.deleteSession).not.toHaveBeenCalled();
    expect(harness.module.closeContext).not.toHaveBeenCalled();
    expect(orchestrator.getStatus(ACCOUNT_URI)?.activeCallIds).toEqual(['call-2']);

    await orchestrator.callEnded(ACCOUNT_URI, 'call-2');
    expect(harness.api.deleteSession).toHaveBeenCalledTimes(1);
    expect(harness.api.deleteSession).toHaveBeenCalledWith(
      'session-41',
      'last-call-ended',
    );
    expect(harness.module.closeContext).toHaveBeenCalledTimes(1);
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'idle',
      activeCallIds: [],
      consumerCount: 0,
      pttLive: false,
      eventTransport: 'disconnected',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts feed mappings as continuous send-only sessions without consumers or PTT', async () => {
    const feedMapping = makeMapping({
      endpointKind: 'feed',
      key: 'feed-3',
      talktomeFeedId: 3,
      target: null,
    });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: feedMapping });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();

    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-feed-3');

    expect(harness.api.createSession).toHaveBeenCalledWith('bridge-main', {
      feedId: 3,
    });
    expect(harness.module.openContext).toHaveBeenCalledWith('feed-3');
    expect(harness.module.bindTransmit).toHaveBeenCalledWith(
      'feed-3',
      expect.any(Object),
    );
    expect(harness.module.setTransmitMuted).toHaveBeenCalledWith('feed-3', false);
    expect(harness.api.getActiveProducers).not.toHaveBeenCalled();
    expect(harness.api.createConsumer).not.toHaveBeenCalled();
    expect(harness.api.resumeProducer).not.toHaveBeenCalled();
    expect(harness.api.pauseProducer).not.toHaveBeenCalled();
    expect(harness.api.setTalkState).not.toHaveBeenCalled();
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      activeCallIds: ['call-1'],
      sessionId: 'session-feed-3',
      producerId: 'local-session-feed-3',
      consumerCount: 0,
      pttLive: true,
    });
  });

  it('uses reserve → consumer → add → resume, deduplicates producer events, and reconciles missed closure', async () => {
    const producerOne = makeActiveProducer('producer-1');
    const producerTwo = makeActiveProducer('producer-2');
    const harness = makeBridgeHarness(
      { [ACCOUNT_URI]: makeMapping() },
      [producerOne],
    );
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    expect(harness.order).toEqual([
      'reserve:producer-1',
      'consumer:producer-1',
      'add:producer-1',
      'resume:producer-1',
    ]);
    expect(harness.api.createConsumer).toHaveBeenCalledTimes(1);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.consumerCount).toBe(1);

    harness.emitEvent(
      'session-41',
      event('new-1', 'new-producer', {
        peerId: producerOne.peerId,
        producerId: producerOne.producerId,
        appData: {},
      }),
    );
    harness.emitEvent(
      'session-41',
      event('new-1-duplicate-payload', 'new-producer', {
        peerId: producerOne.peerId,
        producerId: producerOne.producerId,
        appData: {},
      }),
    );
    harness.emitEvent(
      'session-41',
      event('new-2', 'new-producer', {
        peerId: producerTwo.peerId,
        producerId: producerTwo.producerId,
        appData: {},
      }),
    );
    await flushMicrotasks();

    expect(harness.api.createConsumer).toHaveBeenCalledTimes(2);
    expect(harness.order.slice(-4)).toEqual([
      'reserve:producer-2',
      'consumer:producer-2',
      'add:producer-2',
      'resume:producer-2',
    ]);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.consumerCount).toBe(2);

    harness.setActiveProducers([producerOne]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(harness.module.removeSource).toHaveBeenCalledWith(
      mappingKey(),
      'producer-2',
    );
    expect(harness.api.deleteConsumer).toHaveBeenCalledWith(
      'session-41',
      'consumer-producer-2',
    );
    expect(orchestrator.getStatus(ACCOUNT_URI)?.consumerCount).toBe(1);

    harness.emitEvent(
      'session-41',
      event('closed-1', 'producer-closed', { producerId: 'producer-1' }),
    );
    await flushMicrotasks();
    expect(orchestrator.getStatus(ACCOUNT_URI)?.consumerCount).toBe(0);
    expect(harness.module.removeSource).toHaveBeenCalledWith(
      mappingKey(),
      'producer-1',
    );
    expect(harness.api.deleteConsumer).not.toHaveBeenCalledWith(
      'session-41',
      'consumer-producer-1',
    );
  });

  it('keeps retainOnly producers without creating new consumers (talktome v1.1.1 PTT pause)', async () => {
    const live = makeActiveProducer('producer-live');
    const retained = {
      ...makeActiveProducer('producer-retained'),
      retainOnly: true,
    };
    const harness = makeBridgeHarness(
      { [ACCOUNT_URI]: makeMapping() },
      [live],
    );
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    expect(harness.api.createConsumer).toHaveBeenCalledTimes(1);

    harness.emitEvent(
      'session-41',
      event('retained-1', 'new-producer', {
        peerId: retained.peerId,
        producerId: retained.producerId,
        appData: {},
        retainOnly: true,
      }),
    );
    await flushMicrotasks();
    expect(harness.api.createConsumer).toHaveBeenCalledTimes(1);

    // After PTT pause, the live producer is retained and must not be torn down
    // or recreated.
    harness.setActiveProducers([
      { ...live, retainOnly: true },
      retained,
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(harness.api.createConsumer).toHaveBeenCalledTimes(1);
    expect(harness.module.removeSource).not.toHaveBeenCalled();
    expect(orchestrator.getStatus(ACCOUNT_URI)?.consumerCount).toBe(1);
  });

  it('applies VAD hold timing, talk state, module mute, and active/live tallies', async () => {
    const onTally = vi.fn(async () => undefined);
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness, { onTally });
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    harness.module.setTransmitMuted.mockClear();
    harness.api.resumeProducer.mockClear();
    harness.api.pauseProducer.mockClear();
    harness.api.setTalkState.mockClear();
    onTally.mockClear();

    await orchestrator.updateVadLevel(ACCOUNT_URI, -30);
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith('studio', false);
    expect(harness.api.resumeProducer).toHaveBeenCalledWith(
      'session-41',
      'local-session-41',
    );
    expect(harness.api.setTalkState).toHaveBeenLastCalledWith('session-41', {
      talking: true,
      targets: [{ type: 'conference', id: 9 }],
      lockActive: false,
    });
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(true);

    await orchestrator.updateVadLevel(ACCOUNT_URI, -80);
    await vi.advanceTimersByTimeAsync(299);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith('studio', true);
    expect(harness.api.pauseProducer).toHaveBeenCalledWith(
      'session-41',
      'local-session-41',
    );
    expect(harness.api.setTalkState).toHaveBeenLastCalledWith('session-41', {
      talking: false,
      targets: [],
      lockActive: false,
    });
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(false);

    harness.emitEvent(
      'session-41',
      event('incoming-on', 'incoming-talk-state', {
        state: {
          addressedNow: [
            {
              targetType: 'conference',
              targetId: 9,
              at: 1,
            },
          ],
        },
      }),
    );
    harness.emitEvent(
      'session-41',
      event('incoming-off', 'incoming-talk-state', {
        state: { addressedNow: [] },
      }),
    );
    await flushMicrotasks();

    expect(onTally.mock.calls.map(([update]) => update)).toEqual([
      {
        accountUri: ACCOUNT_URI,
        gpo: 3,
        active: true,
        kind: 'producer-live',
      },
      {
        accountUri: ACCOUNT_URI,
        gpo: 3,
        active: false,
        kind: 'producer-live',
      },
      {
        accountUri: ACCOUNT_URI,
        gpo: 2,
        active: true,
        kind: 'conference-active',
      },
      {
        accountUri: ACCOUNT_URI,
        gpo: 2,
        active: false,
        kind: 'conference-active',
      },
    ]);
  });

  it('combines external and API PTT, reports lock changes, and remains muted after release', async () => {
    const mapping = makeMapping({
      ptt: { mode: 'external', thresholdDb: -45, holdMs: 0, gpi: 6 },
    });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    harness.module.setTransmitMuted.mockClear();
    harness.api.setTalkState.mockClear();
    harness.api.sendCommandResult.mockClear();

    await orchestrator.setExternalPtt(ACCOUNT_URI, true);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(true);
    await orchestrator.setExternalPtt(ACCOUNT_URI, false);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(false);

    harness.emitEvent(
      'session-41',
      event('api-press', 'api-talk-command', {
        commandId: 'command-press',
        action: 'press',
        targetType: 'conference',
        targetId: 9,
      }),
    );
    harness.emitEvent(
      'session-41',
      event('api-lock-on', 'api-talk-command', {
        commandId: 'command-lock-on',
        action: 'lock-toggle',
      }),
    );
    harness.emitEvent(
      'session-41',
      event('api-release', 'api-talk-command', {
        commandId: 'command-release',
        action: 'release',
      }),
    );
    await flushMicrotasks();

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      pttLive: true,
      pttLocked: true,
    });
    expect(harness.api.setTalkState).toHaveBeenCalledWith('session-41', {
      talking: true,
      targets: [{ type: 'conference', id: 9 }],
      lockActive: true,
    });

    harness.emitEvent(
      'session-41',
      event('api-lock-off', 'api-talk-command', {
        commandId: 'command-lock-off',
        action: 'lock-toggle',
      }),
    );
    await flushMicrotasks();

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      pttLive: false,
      pttLocked: false,
    });
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith('studio', true);
    expect(harness.api.sendCommandResult.mock.calls.map(([, result]) => result)).toEqual([
      expect.objectContaining({ commandId: 'command-press', ok: true, action: 'press' }),
      expect.objectContaining({
        commandId: 'command-lock-on',
        ok: true,
        action: 'lock-toggle',
      }),
      expect.objectContaining({
        commandId: 'command-release',
        ok: true,
        action: 'release',
      }),
      expect.objectContaining({
        commandId: 'command-lock-off',
        ok: true,
        action: 'lock-toggle',
      }),
    ]);
  });

  it('ORs per-call external PTT and releases only after the final pressed call clears', async () => {
    const mapping = makeMapping({
      ptt: { mode: 'external', thresholdDb: -45, holdMs: 0, gpi: 6 },
    });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-2');
    await harness.waitForStream('session-41');

    harness.module.setTransmitMuted.mockClear();
    harness.api.pauseProducer.mockClear();
    harness.api.setTalkState.mockClear();

    await orchestrator.setExternalPtt(ACCOUNT_URI, 'call-1', true);
    await orchestrator.setExternalPtt(ACCOUNT_URI, 'call-2', true);
    await orchestrator.setExternalPtt(ACCOUNT_URI, 'call-1', false);

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      activeCallIds: ['call-1', 'call-2'],
      pttLive: true,
    });
    expect(harness.module.setTransmitMuted).toHaveBeenCalledTimes(1);
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith(
      'studio',
      false,
    );
    expect(harness.api.pauseProducer).not.toHaveBeenCalled();

    await orchestrator.callEnded(ACCOUNT_URI, 'call-2');

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      activeCallIds: ['call-1'],
      pttLive: false,
    });
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith(
      'studio',
      true,
    );
    expect(harness.api.pauseProducer).toHaveBeenCalledTimes(1);
    expect(harness.api.deleteSession).not.toHaveBeenCalled();
  });

  it('retries a failed PTT-off safety gate before the next heartbeat', async () => {
    const mapping = makeMapping({
      ptt: { mode: 'external', thresholdDb: -45, holdMs: 0, gpi: 6 },
    });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    await orchestrator.setExternalPtt(ACCOUNT_URI, 'call-1', true);

    harness.module.setTransmitMuted.mockClear();
    harness.api.pauseProducer.mockClear();
    harness.api.setTalkState.mockClear();
    harness.api.heartbeat.mockClear();
    harness.module.setTransmitMuted.mockRejectedValueOnce(
      new Error('temporary module mute failure'),
    );

    await orchestrator.setExternalPtt(ACCOUNT_URI, 'call-1', false);

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'degraded',
      pttLive: true,
    });
    expect(harness.module.setTransmitMuted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.module.setTransmitMuted).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(harness.module.setTransmitMuted).toHaveBeenCalledTimes(2);
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith(
      'studio',
      true,
    );
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(false);
    expect(harness.api.heartbeat).not.toHaveBeenCalled();
  });

  it('never reactivates a rejected API press after its failed rollback retry closes PTT', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    harness.module.setTransmitMuted.mockClear();
    harness.api.resumeProducer.mockClear();
    harness.api.pauseProducer.mockClear();
    harness.api.setTalkState.mockClear();
    harness.api.sendCommandResult.mockClear();
    harness.module.setTransmitMuted
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback mute failed'));
    harness.api.setTalkState.mockRejectedValueOnce(
      new Error('server rejected talk-state true'),
    );

    harness.emitEvent(
      'session-41',
      event('rejected-api-press', 'api-talk-command', {
        commandId: 'rejected-command',
        action: 'press',
        targetType: 'conference',
        targetId: 9,
      }),
    );
    await flushMicrotasks();

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'degraded',
      pttLive: true,
      pttLocked: false,
    });
    expect(harness.api.resumeProducer).toHaveBeenCalledTimes(1);
    expect(harness.module.setTransmitMuted.mock.calls).toEqual([
      ['studio', false],
      ['studio', true],
    ]);
    expect(harness.api.sendCommandResult).toHaveBeenCalledWith(
      'session-41',
      expect.objectContaining({
        commandId: 'rejected-command',
        action: 'press',
        ok: false,
        reason: 'server rejected talk-state true',
      }),
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(harness.module.setTransmitMuted).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      pttLive: false,
      pttLocked: false,
    });
    expect(harness.module.setTransmitMuted).toHaveBeenLastCalledWith(
      'studio',
      true,
    );
    expect(harness.api.pauseProducer).toHaveBeenCalledTimes(2);
    expect(harness.api.resumeProducer).toHaveBeenCalledTimes(1);
    expect(
      harness.api.setTalkState.mock.calls.filter(
        ([, request]) => request.talking,
      ),
    ).toHaveLength(1);
  });

  it('recreates a live feed session when TalkToMe reports the session missing', async () => {
    const feedMapping = makeMapping({
      endpointKind: 'feed',
      key: 'feed-1',
      talktomeFeedId: 1,
    });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: feedMapping });
    const orchestrator = createOrchestrator(harness, {}, true, {
      heartbeatIntervalMs: 1_000,
    });
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-feed-1');

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      pttLive: true,
      sessionId: 'session-feed-1',
      activeCallIds: ['call-1'],
    });

    const absent = Object.assign(
      new Error('Bridge API POST failed: Bridge session not found'),
      { status: 404 },
    );
    harness.api.heartbeat.mockRejectedValueOnce(absent);
    harness.api.createSession.mockClear();
    harness.module.openContext.mockClear();
    harness.module.closeContext.mockClear();
    harness.module.bindTransmit.mockClear();
    harness.module.setTransmitMuted.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(harness.module.closeContext).toHaveBeenCalledWith('feed-1');
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'failed',
      activeCallIds: ['call-1'],
      pttLive: false,
    });
    expect(orchestrator.getStatus(ACCOUNT_URI)).not.toHaveProperty('sessionId');
    expect(harness.api.createSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    await harness.waitForStream('session-feed-1');

    expect(harness.api.createSession).toHaveBeenCalledTimes(1);
    expect(harness.module.openContext).toHaveBeenCalledWith('feed-1');
    expect(harness.module.bindTransmit).toHaveBeenCalled();
    expect(harness.module.setTransmitMuted).toHaveBeenCalledWith('feed-1', false);
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      pttLive: true,
      sessionId: 'session-feed-1',
      activeCallIds: ['call-1'],
    });
  });

  it('stays degraded on retryable heartbeat failures without recreating the session', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness, {}, true, {
      heartbeatIntervalMs: 1_000,
    });
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    harness.api.heartbeat.mockRejectedValueOnce(
      Object.assign(new Error('Bridge API POST failed: HTTP 503'), {
        status: 503,
      }),
    );
    harness.api.createSession.mockClear();
    harness.module.closeContext.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'degraded',
      sessionId: 'session-41',
      activeCallIds: ['call-1'],
    });
    expect(harness.module.closeContext).not.toHaveBeenCalled();
    expect(harness.api.createSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(harness.api.createSession).not.toHaveBeenCalled();
    expect(orchestrator.getStatus(ACCOUNT_URI)?.sessionId).toBe('session-41');
  });

  it('recreates a user session after a poll/reconcile session-not-found error', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness, {}, true, {
      heartbeatIntervalMs: 120_000,
      eventReconcileIntervalMs: 1_000,
    });
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    const absent = Object.assign(
      new Error('Bridge API GET failed: Bridge session not found'),
      { status: 404 },
    );
    harness.api.getActiveProducers.mockRejectedValueOnce(absent);
    harness.api.createSession.mockClear();
    harness.module.openContext.mockClear();
    harness.module.closeContext.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(harness.module.closeContext).toHaveBeenCalledWith('studio');
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'failed',
      activeCallIds: ['call-1'],
    });
    expect(orchestrator.getStatus(ACCOUNT_URI)).not.toHaveProperty('sessionId');

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    await harness.waitForStream('session-41');

    expect(harness.api.createSession).toHaveBeenCalledTimes(1);
    expect(harness.module.openContext).toHaveBeenCalledWith('studio');
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      sessionId: 'session-41',
      activeCallIds: ['call-1'],
    });
  });

  it('keeps a failed session deletion stopping until retry and replaces it only while calls remain', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness);
    const absent = Object.assign(new Error('session not found'), {
      status: 404,
    });
    harness.api.deleteSession
      .mockResolvedValue({ ok: true })
      .mockRejectedValueOnce(new Error('temporary DELETE failure'))
      .mockRejectedValueOnce(absent)
      .mockRejectedValueOnce(new Error('second temporary DELETE failure'))
      .mockRejectedValueOnce(absent);

    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    await orchestrator.callEnded(ACCOUNT_URI, 'call-1');

    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'stopping',
      activeCallIds: [],
      sessionId: 'session-41',
    });
    expect(harness.module.closeContext).not.toHaveBeenCalled();

    await orchestrator.callEstablished(ACCOUNT_URI, 'call-2');
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'stopping',
      activeCallIds: ['call-2'],
      sessionId: 'session-41',
    });
    expect(harness.module.openContext).toHaveBeenCalledTimes(1);
    expect(harness.api.createSession).toHaveBeenCalledTimes(1);
    expect(harness.module.closeContext).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    await harness.waitForStream('session-41');

    expect(harness.api.deleteSession).toHaveBeenCalledTimes(2);
    expect(harness.module.closeContext).toHaveBeenCalledTimes(1);
    expect(harness.module.openContext).toHaveBeenCalledTimes(2);
    expect(harness.api.createSession).toHaveBeenCalledTimes(2);
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      activeCallIds: ['call-2'],
      sessionId: 'session-41',
    });

    await orchestrator.callEnded(ACCOUNT_URI, 'call-2');
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'stopping',
      activeCallIds: [],
      sessionId: 'session-41',
    });
    expect(harness.module.closeContext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(harness.api.deleteSession).toHaveBeenCalledTimes(4);
    expect(harness.module.closeContext).toHaveBeenCalledTimes(2);
    expect(harness.module.openContext).toHaveBeenCalledTimes(2);
    expect(harness.api.createSession).toHaveBeenCalledTimes(2);
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'idle',
      activeCallIds: [],
      pttLive: false,
      eventTransport: 'disconnected',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a reconciliation callback from a stale session generation', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    let resolveStale!: (
      producers: Array<ReturnType<typeof makeActiveProducer>>,
    ) => void;
    const staleRequest = new Promise<
      Array<ReturnType<typeof makeActiveProducer>>
    >((resolve) => {
      resolveStale = resolve;
    });
    harness.api.getActiveProducers.mockClear();
    harness.api.getActiveProducers.mockImplementationOnce(() => staleRequest);
    harness.api.createConsumer.mockClear();
    harness.module.addSource.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(harness.api.getActiveProducers).toHaveBeenCalledTimes(1);

    await orchestrator.callEnded(ACCOUNT_URI, 'call-1');
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-2');
    await harness.waitForStream('session-41');
    resolveStale([makeActiveProducer('producer-from-old-generation')]);
    await flushMicrotasks();

    expect(harness.api.createConsumer).not.toHaveBeenCalledWith(
      'session-41',
      'producer-from-old-generation',
    );
    expect(harness.module.addSource).not.toHaveBeenCalledWith(
      'studio',
      expect.objectContaining({
        producerId: 'producer-from-old-generation',
      }),
    );
    expect(orchestrator.getStatus(ACCOUNT_URI)).toMatchObject({
      phase: 'connected',
      activeCallIds: ['call-2'],
      consumerCount: 0,
    });
  });

  it('isolates one account setup failure from another concurrent account', async () => {
    const badUri = 'sip:bad@example.com';
    const goodUri = 'sip:good@example.com';
    const badMapping = makeMapping({
      key: 'bad',
      talktomeUserId: 51,
      target: { type: 'user', id: 51 },
    });
    const goodMapping = makeMapping({
      key: 'good',
      talktomeUserId: 52,
      target: { type: 'user', id: 52 },
    });
    const harness = makeBridgeHarness({
      [badUri]: badMapping,
      [goodUri]: goodMapping,
    });
    harness.module.openContext.mockImplementation(async (key: string) => {
      if (key === 'bad') throw new Error('bad account module failure');
    });
    const onError = vi.fn(() => {
      // Error observers are intentionally allowed to fail too.
      throw new Error('observer failure');
    });
    const orchestrator = createOrchestrator(harness, { onError });
    await orchestrator.initialize();

    await Promise.all([
      orchestrator.callEstablished(badUri, 'bad-call'),
      orchestrator.callEstablished(goodUri, 'good-call'),
    ]);

    expect(orchestrator.getStatus(badUri)).toMatchObject({
      phase: 'failed',
      lastError: 'bad account module failure',
    });
    expect(orchestrator.getStatus(goodUri)).toMatchObject({
      phase: 'connected',
      sessionId: 'session-52',
      producerId: 'local-session-52',
    });
    expect(harness.api.createSession).toHaveBeenCalledTimes(1);
    expect(harness.api.createSession).toHaveBeenCalledWith('bridge-main', {
      userId: 52,
    });
    expect(harness.module.bindTransmit).toHaveBeenCalledWith(
      'good',
      expect.any(Object),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), badUri);
  });

  it('performs no HTTP, module, mapping, or timer work when globally disabled', async () => {
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: makeMapping() });
    const orchestrator = createOrchestrator(harness, {}, false);

    await expect(orchestrator.initialize()).resolves.toBeUndefined();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await orchestrator.callEnded(ACCOUNT_URI, 'call-1');
    await orchestrator.allCallsEnded(ACCOUNT_URI);
    await orchestrator.refreshAccount(ACCOUNT_URI);
    await orchestrator.updateVadLevel(ACCOUNT_URI, -20);
    await orchestrator.setExternalPtt(ACCOUNT_URI, true);
    await orchestrator.setReceiveActivity(ACCOUNT_URI, 'producer-1', true);
    await orchestrator.setAggregateReceiveActivity(ACCOUNT_URI, true);
    await orchestrator.stop();

    for (const spy of Object.values(harness.api)) {
      expect(spy).not.toHaveBeenCalled();
    }
    for (const spy of Object.values(harness.module)) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(harness.mappings.getAccount).not.toHaveBeenCalled();
    expect(harness.mappings.getEnabledAccounts).not.toHaveBeenCalled();
    expect(orchestrator.getAllStatuses()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function mappingKey(): string {
  return 'studio';
}
