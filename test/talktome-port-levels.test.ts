import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TalktomeBridgeOrchestrator } from '~/server/services/talktome/orchestrator';
import { CtrlTcpTalktomeModuleController } from '~/server/services/talktome/module-controller';
import { portLevelGain } from '~/server/services/talktome/target-audio';
import type {
  BridgeActiveProducer,
  BridgePortAudioLevels,
  BridgeUserPort,
} from '~/server/services/talktome/types';
import {
  ACCOUNT_URI,
  asBridgeApi,
  asModule,
  flushMicrotasks,
  makeBridgeHarness,
  makeMapping,
} from './helpers/talktome';

describe('port level gain', () => {
  it('converts talktome dB levels and mute to a linear factor', () => {
    expect(portLevelGain(undefined)).toBe(1);
    expect(portLevelGain({ gainDb: 0, muted: false })).toBe(1);
    expect(portLevelGain({ gainDb: 20, muted: false })).toBeCloseTo(10);
    expect(portLevelGain({ gainDb: -60, muted: false })).toBeCloseTo(0.01);
    expect(portLevelGain({ gainDb: 6, muted: true })).toBe(0);
  });

  it('sends transmit and source gains as permille up to +40 dB', async () => {
    const execute = vi.fn(async () => '{"changed":true}');
    const controller = new CtrlTcpTalktomeModuleController({ execute });
    await controller.setTransmitGain('studio', 2.5);
    await controller.setSourceGain('studio', 'producer-1', 100);
    expect(execute).toHaveBeenCalledWith('ms_ctx_gain', 'studio 2500');
    expect(execute).toHaveBeenCalledWith('ms_src_gain', 'studio producer-1 100000');
    await expect(controller.setTransmitGain('studio', 101)).rejects.toThrow('0 to 100');
  });
});

describe('port levels from talktome Admin', () => {
  const orchestrators: TalktomeBridgeOrchestrator[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    await Promise.all(orchestrators.splice(0).map((orchestrator) => orchestrator.stop()));
    await flushMicrotasks();
    vi.useRealTimers();
  });

  const speaker: BridgeActiveProducer = {
    peerId: 'peer-anna',
    producerId: 'anna',
    appData: { type: 'conference', id: 9 },
    speakerUserId: 77,
  };

  it('applies input and output gain at start and follows Admin changes on the next announce', async () => {
    const mapping = makeMapping();
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping }, [speaker]);
    const config = await harness.api.getConfig();
    const port = config.ports[0] as BridgeUserPort;
    const levels: BridgePortAudioLevels = {
      input: { gainDb: 20, muted: false },
      output: { gainDb: 6, muted: false },
    };
    port.audioLevels = levels;

    const orchestrator = new TalktomeBridgeOrchestrator({
      enabled: true,
      bridgeId: 'bridge-main',
      api: asBridgeApi(harness.api),
      module: asModule(harness.module),
      mappings: harness.mappings,
      announcement: {
        bridgeId: 'bridge-main',
        platform: 'test',
        inventory: { host: '127.0.0.1', devices: [] },
      },
      announceIntervalMs: 10_000,
      heartbeatIntervalMs: 120_000,
      eventPollIntervalMs: 1_000,
      eventReconcileIntervalMs: 1_000,
    });
    orchestrators.push(orchestrator);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    await flushMicrotasks();

    expect(harness.module.setTransmitGain).toHaveBeenCalledWith('studio', expect.closeTo(10, 6));
    // Default target volume 0.9 times +6 dB output.
    expect(harness.module.setSourceGain).toHaveBeenLastCalledWith('studio', 'anna', expect.closeTo(0.9 * 1.9953, 3));

    harness.module.setTransmitGain.mockClear();
    harness.module.setSourceGain.mockClear();
    port.audioLevels = { input: { gainDb: 0, muted: true }, output: { gainDb: 6, muted: true } };
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(harness.module.setTransmitGain).toHaveBeenCalledWith('studio', 0);
    expect(harness.module.setSourceGain).toHaveBeenCalledWith('studio', 'anna', 0);
  });
});
