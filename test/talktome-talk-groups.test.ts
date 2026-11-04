import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TalktomeConfigValidationError,
  validateTalktomeBridgeConfig,
} from '~/server/services/talktome-bridge-config';
import { TalktomeBridgeOrchestrator } from '~/server/services/talktome/orchestrator';
import type {
  BridgeControlEvent,
  BridgeControlEventName,
  BridgeUserPort,
  JsonObject,
} from '~/server/services/talktome/types';
import type { TalktomeTarget } from '~/types';
import {
  ACCOUNT_URI,
  asBridgeApi,
  asModule,
  flushMicrotasks,
  makeBridgeHarness,
  makeMapping,
} from './helpers/talktome';

const CONFERENCE: TalktomeTarget = { type: 'conference', id: 9 };
const DIRECTOR: TalktomeTarget = { type: 'user', id: 12 };

describe('talk group configuration', () => {
  const account = (mapping: Record<string, unknown>) =>
    validateTalktomeBridgeConfig({ accounts: { 'sip:studio@example.com': { talktomeUserId: 41, ...mapping } } })
      .accounts['sip:studio@example.com'];
  const issues = (mapping: Record<string, unknown>) => {
    try {
      account(mapping);
    } catch (error) {
      if (error instanceof TalktomeConfigValidationError) {
        return (error as TalktomeConfigValidationError).issues.join('\n');
      }
      throw error;
    }
    return '';
  };

  it('stores a group but keeps a single target in the old shape', () => {
    expect(account({ target: CONFERENCE, targets: [CONFERENCE, DIRECTOR, DIRECTOR] }))
      .toMatchObject({ target: CONFERENCE, targets: [CONFERENCE, DIRECTOR] });
    expect(account({ target: CONFERENCE, targets: [CONFERENCE] })).not.toHaveProperty('targets');
    expect(account({ target: CONFERENCE })).not.toHaveProperty('targets');
    expect(account({ targets: [DIRECTOR, CONFERENCE] })).toMatchObject({ target: DIRECTOR });
  });

  it('accepts always-on and rejects inconsistent groups', () => {
    expect(account({ target: CONFERENCE, ptt: { mode: 'always-on' } }).ptt.mode).toBe('always-on');
    expect(issues({ target: CONFERENCE, targets: [DIRECTOR, CONFERENCE] })).toContain('first entry of targets');
    expect(issues({ target: CONFERENCE, targets: [] })).toContain('non-empty array');
    expect(issues({ target: CONFERENCE, ptt: { mode: 'push' } })).toContain('audio-level, always-on or external');
    expect(
      issues({ endpointKind: 'feed', talktomeUserId: undefined, talktomeFeedId: 3, targets: [CONFERENCE] }),
    ).toContain('only supported for user endpoints');
  });
});

describe('talk groups, always on and reply', () => {
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

  function event(id: string, name: BridgeControlEventName, payload: JsonObject): BridgeControlEvent {
    return { id, event: name, payload, at: '2026-01-01T00:00:00.000Z' };
  }

  function create(harness: ReturnType<typeof makeBridgeHarness>) {
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
    return orchestrator;
  }

  const talkCalls = (harness: ReturnType<typeof makeBridgeHarness>) =>
    (harness.api.setTalkState.mock.calls as unknown[][]).map((call) => call[1] as JsonObject);
  const lastTalk = (harness: ReturnType<typeof makeBridgeHarness>) => {
    const calls = talkCalls(harness);
    return calls[calls.length - 1];
  };
  const lastResult = (harness: ReturnType<typeof makeBridgeHarness>) => {
    const calls = harness.api.sendCommandResult.mock.calls as unknown[][];
    return calls[calls.length - 1]?.[1] as JsonObject;
  };

  it('always on talks to the whole group as soon as the session is up', async () => {
    const mapping = makeMapping({ targets: [CONFERENCE, DIRECTOR], ptt: { mode: 'always-on', thresholdDb: -45, holdMs: 0, gpi: 1 } });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = create(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');
    await flushMicrotasks();

    expect(talkCalls(harness)).toEqual([{ talking: true, targets: [CONFERENCE, DIRECTOR], lockActive: false }]);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(true);

    // A release cannot close an always-on bridge.
    harness.emitEvent('session-41', event('release', 'api-talk-command', { commandId: 'c1', action: 'release' }));
    await flushMicrotasks();
    expect(talkCalls(harness).some((call) => call.talking === false)).toBe(false);
    expect(orchestrator.getStatus(ACCOUNT_URI)?.pttLive).toBe(true);
  });

  it('accepts any group member and adds the last caller while Reply is held', async () => {
    const mapping = makeMapping({ targets: [CONFERENCE, DIRECTOR], ptt: { mode: 'external', thresholdDb: -45, holdMs: 0, gpi: 1 } });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const orchestrator = create(harness);
    await orchestrator.initialize();
    await orchestrator.callEstablished(ACCOUNT_URI, 'call-1');
    await harness.waitForStream('session-41');

    harness.emitEvent('session-41', event('member', 'api-talk-command', {
      commandId: 'c-member', action: 'press', targetType: 'user', targetId: 12,
    }));
    await flushMicrotasks();
    expect(lastResult(harness)).toMatchObject({ commandId: 'c-member', ok: true });
    expect(lastTalk(harness)).toMatchObject({ talking: true, targets: [CONFERENCE, DIRECTOR] });

    harness.emitEvent('session-41', event('stranger', 'api-talk-command', {
      commandId: 'c-stranger', action: 'press', targetType: 'user', targetId: 99,
    }));
    harness.emitEvent('session-41', event('release', 'api-talk-command', { commandId: 'c-release', action: 'release' }));
    await flushMicrotasks();
    expect((harness.api.sendCommandResult.mock.calls as unknown[][]).map((call) => call[1] as JsonObject))
      .toEqual(expect.arrayContaining([expect.objectContaining({ commandId: 'c-stranger', ok: false })]));

    harness.emitEvent('session-41', event('calls', 'incoming-talk-state', {
      state: { addressedNow: [], replyTarget: { targetType: 'user', targetId: 77, replyTargetType: 'user', replyTargetId: 77, at: 1 } },
    }));
    harness.emitEvent('session-41', event('reply', 'api-talk-command', {
      commandId: 'c-reply', action: 'press', targetType: 'reply',
    }));
    await flushMicrotasks();
    expect(lastResult(harness)).toMatchObject({ commandId: 'c-reply', ok: true });
    expect(lastTalk(harness)).toMatchObject({
      talking: true,
      targets: [CONFERENCE, DIRECTOR, { type: 'user', id: 77 }],
    });

    // A conference the bridge may not talk into is no Reply destination.
    harness.emitEvent('session-41', event('release-reply', 'api-talk-command', { commandId: 'c-r2', action: 'release' }));
    harness.emitEvent('session-41', event('blocked', 'incoming-talk-state', {
      state: { addressedNow: [], replyTarget: { targetType: 'conference', targetId: 5, replyTargetType: 'conference', replyTargetId: 5, canReply: false, at: 2 } },
    }));
    harness.emitEvent('session-41', event('reply-2', 'api-talk-command', {
      commandId: 'c-reply-2', action: 'press', targetType: 'reply',
    }));
    await flushMicrotasks();
    expect(lastResult(harness)).toMatchObject({ commandId: 'c-reply-2', ok: false });
  });

  it('never cuts a talk group down when provisioning endpoint devices', async () => {
    const mapping = makeMapping({ targets: [CONFERENCE, DIRECTOR] });
    const harness = makeBridgeHarness({ [ACCOUNT_URI]: mapping });
    const config = await harness.api.getConfig();
    const port = config.ports[0] as BridgeUserPort;
    port.input = { deviceId: 'hw:0', leftChannel: 1, rightChannel: 2 };
    // Same members in another order: no trigger change is needed.
    port.trigger.targets = [DIRECTOR, CONFERENCE];
    harness.api.putUserEndpoint.mockClear();

    const orchestrator = create(harness);
    await orchestrator.initialize();

    const updates = (harness.api.putUserEndpoint.mock.calls as unknown[][]).map((call) => call[2] as JsonObject);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.triggerTargets).toEqual(expect.arrayContaining([CONFERENCE, DIRECTOR]));
      expect(update.triggerTargets).toHaveLength(2);
    }
  });
});
