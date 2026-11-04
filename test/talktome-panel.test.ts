import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TalktomeBridgeOrchestrator } from '~/server/services/talktome/orchestrator';
import { CtrlTcpTalktomeModuleController } from '~/server/services/talktome/module-controller';
import {
  DEFAULT_TARGET_VOLUME,
  applyTargetAudioCommand,
  normalizePanelSettings,
  sourceGain,
  stateMap,
  type TargetAudioState,
} from '~/server/services/talktome/target-audio';
import {
  normalizeBridgeClientVersion,
  resolveBridgeClientVersion,
} from '~/server/services/talktome/version';
import type {
  BridgeActiveProducer,
  BridgeControlEvent,
  BridgeControlEventName,
  JsonObject,
} from '~/server/services/talktome/types';
import {
  ACCOUNT_URI,
  asBridgeApi,
  asModule,
  flushMicrotasks,
  makeBridgeHarness,
  makeMapping,
  makeUserPort,
} from './helpers/talktome';

const BRIDGE_USER = 41;
const CONFERENCE = 9;

function panelStorage(levels: JsonObject, exclusions: JsonObject = {}): Record<string, string> {
  return {
    [`conferenceMemberLevels:user:${BRIDGE_USER}`]: JSON.stringify(levels),
    [`conferenceListenExclusions:user:${BRIDGE_USER}`]: JSON.stringify(exclusions),
  };
}

describe('target audio gain', () => {
  const conference = (speakerUserId: number) => ({ appType: 'conference', appId: CONFERENCE, speakerUserId });

  it('uses talktome defaults without saved state', () => {
    expect(sourceGain(BRIDGE_USER, conference(77), new Map(), normalizePanelSettings(null)))
      .toBe(DEFAULT_TARGET_VOLUME);
  });

  it('multiplies the conference volume by the member level and honours both mutes', () => {
    const states = stateMap([{ targetType: 'conference', targetId: CONFERENCE, volume: 0.5, muted: false }]);
    const panel = { revision: 1, storage: panelStorage({ [CONFERENCE]: { 77: 0.4 } }, { [CONFERENCE]: [78] }) };
    expect(sourceGain(BRIDGE_USER, conference(77), states, panel)).toBeCloseTo(0.2);
    expect(sourceGain(BRIDGE_USER, conference(78), states, panel)).toBe(0);
    expect(sourceGain(BRIDGE_USER, conference(79), states, panel)).toBe(0.5);

    states.set(`conference:${CONFERENCE}`, { targetType: 'conference', targetId: CONFERENCE, volume: 0.5, muted: true });
    expect(sourceGain(BRIDGE_USER, conference(77), states, panel)).toBe(0);
  });

  it('applies a direct call to the speaking user and ignores broken storage', () => {
    const states = stateMap([{ targetType: 'user', targetId: 77, volume: 0.3, muted: false }]);
    const panel = { revision: 1, storage: { [`conferenceMemberLevels:user:${BRIDGE_USER}`]: '{not json' } };
    expect(sourceGain(BRIDGE_USER, { appType: 'talk', speakerUserId: 77 }, states, panel)).toBe(0.3);
    expect(sourceGain(BRIDGE_USER, conference(77), states, panel)).toBe(DEFAULT_TARGET_VOLUME);
  });

  it('steps and toggles Companion target audio within 0..1', () => {
    const states = new Map<string, TargetAudioState>();
    expect(applyTargetAudioCommand(states, { action: 'volume-up', targetType: 'conference', targetId: 9 }).volume)
      .toBe(1);
    expect(applyTargetAudioCommand(states, { action: 'volume-down', targetType: 'conference', targetId: 9, step: 0.25 }).volume)
      .toBe(0.75);
    expect(applyTargetAudioCommand(states, { action: 'mute-toggle', targetType: 'conference', targetId: 9 }).muted)
      .toBe(true);
    expect(() => applyTargetAudioCommand(states, { action: 'volume-up', targetType: 'conference', targetId: Number.NaN }))
      .toThrow('target-not-available');
  });
});

describe('bridge client version', () => {
  it('announces release tags without the leading v', () => {
    expect(normalizeBridgeClientVersion('v1.4.1')).toBe('1.4.1');
    expect(normalizeBridgeClientVersion(' 1.3.3-beta-rc2\n')).toBe('1.3.3-beta-rc2');
    expect(normalizeBridgeClientVersion('unknown')).toBeUndefined();
    expect(normalizeBridgeClientVersion('dev')).toBeUndefined();
    expect(normalizeBridgeClientVersion('a b')).toBeUndefined();
  });

  it('prefers APP_VERSION and falls back to the built version.js', () => {
    const files: Record<string, string> = { '.output/public/version.js': 'v1.5.0\n' };
    const read = (path: string) => files[path];
    expect(resolveBridgeClientVersion({ APP_VERSION: 'v1.6.0' }, read)).toBe('1.6.0');
    expect(resolveBridgeClientVersion({ APP_VERSION: 'unknown' }, read)).toBe('1.5.0');
    expect(resolveBridgeClientVersion({}, () => undefined)).toBeUndefined();
  });
});

describe('module source gain', () => {
  it('sends integer permille and rejects out-of-range gains', async () => {
    const execute = vi.fn(async () => '{"changed":true}');
    const controller = new CtrlTcpTalktomeModuleController({ execute });
    await controller.setSourceGain('studio', 'producer-1', 0.456);
    expect(execute).toHaveBeenCalledWith('ms_src_gain', 'studio producer-1 456');
    // Up to +40 dB, so a port output gain can boost quiet streams.
    await expect(controller.setSourceGain('studio', 'producer-1', 100.5)).rejects.toThrow('0 to 100');
    await expect(controller.setSourceGain('studio', 'producer-1', -0.1)).rejects.toThrow('0 to 100');
  });
});

describe('remote panel commands', () => {
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

  function speaker(producerId: string, userId: number): BridgeActiveProducer {
    return {
      peerId: `peer-${producerId}`,
      producerId,
      appData: { type: 'conference', id: CONFERENCE },
      speakerUserId: userId,
      speakerName: `User ${userId}`,
      speakerKind: 'user',
    };
  }

  function event(id: string, name: BridgeControlEventName, payload: JsonObject): BridgeControlEvent {
    return { id, event: name, payload, at: '2026-01-01T00:00:00.000Z' };
  }

  async function connectedBridge() {
    const mapping = makeMapping();
    const harness = makeBridgeHarness(
      { [ACCOUNT_URI]: mapping },
      [speaker('anna', 77), speaker('ben', 78)],
    );
    harness.api.createSession.mockImplementation(async () => ({
      sessionId: 'session-41',
      port: makeUserPort(mapping),
      panelSettings: { revision: 3, storage: panelStorage({ [CONFERENCE]: { 77: 0.5 } }) },
      targetAudioStates: [{ targetType: 'conference', targetId: CONFERENCE, volume: 0.8, muted: false }],
    }) as never);
    const orchestrator = new TalktomeBridgeOrchestrator({
      enabled: true,
      bridgeId: 'bridge-main',
      api: asBridgeApi(harness.api),
      module: asModule(harness.module),
      mappings: harness.mappings,
      heartbeatIntervalMs: 120_000,
      eventPollIntervalMs: 1_000,
      eventReconcileIntervalMs: 1_000,
    });
    orchestrators.push(orchestrator);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    await flushMicrotasks();
    return { harness, orchestrator };
  }

  // The harness mocks take no typed parameters, so read the calls loosely.
  const callsOf = (mock: { mock: { calls: unknown } }) => mock.mock.calls as unknown[][];
  const gains = (harness: ReturnType<typeof makeBridgeHarness>) =>
    Object.fromEntries(callsOf(harness.module.setSourceGain).map(
      (call) => [String(call[1]), Number(call[2])],
    ));

  it('applies saved volumes and member levels before resuming each stream', async () => {
    const { harness } = await connectedBridge();
    expect(gains(harness)).toEqual({ anna: 0.4, ben: 0.8 });
    const gainOrder = harness.module.setSourceGain.mock.invocationCallOrder[0];
    const resumeOrder = harness.api.resumeConsumer.mock.invocationCallOrder[0];
    expect(gainOrder).toBeLessThan(resumeOrder);
  });

  it('confirms panel volume, member and talk changes with a report', async () => {
    const { harness } = await connectedBridge();
    harness.module.setSourceGain.mockClear();
    harness.api.sendCommandResult.mockClear();

    harness.emitEvent('session-41', event('vol', 'panel-command', {
      commandId: 'c-volume',
      kind: 'target-audio',
      targetType: 'conference',
      targetId: CONFERENCE,
      audio: { targetType: 'conference', targetId: CONFERENCE, volume: 0.6, muted: false },
      panelSettings: { revision: 4, storage: panelStorage({ [CONFERENCE]: { 77: 0.5 } }) },
    }));
    await flushMicrotasks();
    expect(gains(harness)).toEqual({ anna: 0.3, ben: 0.6 });
    expect(harness.api.sendCommandResult).toHaveBeenLastCalledWith('session-41', expect.objectContaining({
      commandId: 'c-volume',
      ok: true,
      report: expect.objectContaining({
        revision: 4,
        audioStates: [{ targetType: 'conference', targetId: CONFERENCE, volume: 0.6, muted: false }],
      }),
    }));

    harness.module.setSourceGain.mockClear();
    harness.emitEvent('session-41', event('member', 'panel-command', {
      commandId: 'c-member',
      kind: 'preferences',
      patch: {},
      panelSettings: {
        revision: 5,
        storage: panelStorage({ [CONFERENCE]: { 77: 0.5 } }, { [CONFERENCE]: [78] }),
      },
    }));
    await flushMicrotasks();
    // Only Ben changes: he is now excluded from the bridge's mix.
    expect(gains(harness)).toEqual({ ben: 0 });

    harness.emitEvent('session-41', event('press', 'panel-command', {
      commandId: 'c-press',
      kind: 'talk',
      action: 'press',
      targetType: 'conference',
      targetId: CONFERENCE,
      inputKey: 'panel:socket:main',
    }));
    await flushMicrotasks();
    expect(harness.api.setTalkState).toHaveBeenLastCalledWith('session-41', expect.objectContaining({ talking: true }));
    expect(harness.api.sendCommandResult).toHaveBeenLastCalledWith('session-41', expect.objectContaining({
      commandId: 'c-press',
      ok: true,
      report: expect.objectContaining({ runtime: expect.objectContaining({ talking: true }) }),
    }));

    harness.emitEvent('session-41', event('stop', 'panel-command', { commandId: 'c-stop', kind: 'talk', action: 'stop' }));
    await flushMicrotasks();
    expect(harness.api.setTalkState).toHaveBeenLastCalledWith('session-41', expect.objectContaining({ talking: false }));
  });

  it('answers state requests and rejects what a bridge cannot change', async () => {
    const { harness } = await connectedBridge();
    harness.api.sendCommandResult.mockClear();

    harness.emitEvent('session-41', event('state', 'panel-state-request', {}));
    harness.emitEvent('session-41', event('prod', 'panel-command', { commandId: 'c-prod', kind: 'production' }));
    harness.emitEvent('session-41', event('other', 'panel-command', {
      commandId: 'c-other-target',
      kind: 'talk',
      action: 'press',
      targetType: 'conference',
      targetId: 99,
    }));
    await flushMicrotasks();

    const results = callsOf(harness.api.sendCommandResult).map((call) => call[1] as JsonObject);
    expect(results[0]).not.toHaveProperty('commandId');
    expect(results[0]).toMatchObject({ ok: true, report: expect.objectContaining({ revision: 3 }) });
    expect(results[1]).toMatchObject({ commandId: 'c-prod', ok: false });
    expect(results[2]).toMatchObject({ commandId: 'c-other-target', ok: false });
  });

  it('handles Companion volume commands itself and keeps playing on an old module', async () => {
    const { harness } = await connectedBridge();
    harness.module.setSourceGain.mockClear();
    harness.module.setSourceGain.mockRejectedValue(new Error('Unknown command ms_src_gain'));
    harness.api.sendCommandResult.mockClear();

    harness.emitEvent('session-41', event('companion', 'api-target-audio-command', {
      commandId: 'c-companion',
      action: 'mute-toggle',
      targetType: 'conference',
      targetId: CONFERENCE,
    }));
    await flushMicrotasks();

    expect(harness.module.setSourceGain).toHaveBeenCalled();
    expect(harness.api.sendCommandResult).toHaveBeenLastCalledWith('session-41', expect.objectContaining({
      commandId: 'c-companion',
      ok: true,
      muted: true,
    }));
  });
});
