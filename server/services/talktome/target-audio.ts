/**
 * Playout gain of received talktome streams, matching the official
 * bridge-client: the target volume (conference, direct user or feed) times
 * the per-member level inside a conference, silenced by either mute.
 *
 * The talktome remote panel edits these values: target volumes arrive as
 * `target-audio` panel commands, member levels and member listen exclusions
 * as panel `storage` keys of the bridge user.
 */
import type { BridgeTargetAudioCommandPayload, JsonObject } from './types';

/** talktome's default volume for a target without a saved state. */
export const DEFAULT_TARGET_VOLUME = 0.9;
const DEFAULT_VOLUME_STEP = 0.1;

export type TargetAudioType = 'conference' | 'user' | 'feed';

export interface TargetAudioState {
  targetType: TargetAudioType;
  targetId: number;
  volume: number;
  muted: boolean;
}

export interface PanelSettings {
  revision: number;
  storage: Record<string, string>;
}

/** What a received stream belongs to, from the producer's announcement. */
export interface SourceIdentity {
  appType?: string;
  appId?: number;
  speakerUserId?: number | null;
}

export function emptyPanelSettings(): PanelSettings {
  return { revision: 0, storage: {} };
}

export function targetAudioKey(targetType: string, targetId: number): string | undefined {
  const type = String(targetType || '').trim().toLowerCase();
  if (!['conference', 'user', 'feed'].includes(type) || !Number.isFinite(targetId)) {
    return undefined;
  }
  return `${type}:${targetId}`;
}

export function normalizeTargetAudioState(value: unknown): TargetAudioState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const targetType = String(raw.targetType || '').trim().toLowerCase() as TargetAudioType;
  const targetId = Number(raw.targetId);
  if (!targetAudioKey(targetType, targetId)) return undefined;
  const volume = Number(raw.volume);
  return {
    targetType,
    targetId,
    volume: clampUnit(Number.isFinite(volume) ? volume : DEFAULT_TARGET_VOLUME),
    muted: raw.muted === true,
  };
}

export function normalizePanelSettings(value: unknown): PanelSettings {
  if (!value || typeof value !== 'object') return emptyPanelSettings();
  const raw = value as Record<string, unknown>;
  const storage: Record<string, string> = {};
  if (raw.storage && typeof raw.storage === 'object') {
    for (const [key, entry] of Object.entries(raw.storage as Record<string, unknown>)) {
      if (typeof entry === 'string') storage[key] = entry;
    }
  }
  const revision = Number(raw.revision);
  return { revision: Number.isSafeInteger(revision) ? revision : 0, storage };
}

export function stateMap(states: Iterable<TargetAudioState>): Map<string, TargetAudioState> {
  const map = new Map<string, TargetAudioState>();
  for (const state of states) {
    const key = targetAudioKey(state.targetType, state.targetId);
    if (key) map.set(key, state);
  }
  return map;
}

export function sourceIdentityFromProducer(producer: {
  appData?: JsonObject;
  speakerUserId?: number | null;
}): SourceIdentity {
  const appType = typeof producer.appData?.type === 'string'
    ? producer.appData.type.trim().toLowerCase()
    : undefined;
  const appId = Number(producer.appData?.id);
  return {
    ...(appType ? { appType } : {}),
    ...(Number.isFinite(appId) ? { appId } : {}),
    speakerUserId: typeof producer.speakerUserId === 'number' ? producer.speakerUserId : null,
  };
}

/**
 * Target whose volume applies: the conference or feed the stream belongs to,
 * otherwise the speaking user (a direct call).
 */
export function sourceTargetKey(source: SourceIdentity): string | undefined {
  if ((source.appType === 'conference' || source.appType === 'feed') && source.appId !== undefined) {
    return targetAudioKey(source.appType, source.appId);
  }
  if (typeof source.speakerUserId === 'number') {
    return targetAudioKey('user', source.speakerUserId);
  }
  return undefined;
}

/** Linear gain 0..1 for one received stream of bridge user `userId`. */
export function sourceGain(
  userId: number,
  source: SourceIdentity,
  states: Map<string, TargetAudioState>,
  panel: PanelSettings,
): number {
  const key = sourceTargetKey(source);
  const state = key ? states.get(key) : undefined;
  let volume = state ? state.volume : DEFAULT_TARGET_VOLUME;
  let muted = state ? state.muted : false;

  const storage = panel.storage;
  if (source.appType === 'conference' && source.appId !== undefined && typeof source.speakerUserId === 'number') {
    const conferenceId = String(source.appId);
    const excluded = parseStorageObject(storage[`conferenceListenExclusions:user:${userId}`]);
    const levels = parseStorageObject(storage[`conferenceMemberLevels:user:${userId}`]);
    const excludedIds = Array.isArray(excluded[conferenceId]) ? excluded[conferenceId] as unknown[] : [];
    if (excludedIds.map(Number).includes(source.speakerUserId)) muted = true;
    const memberLevels = levels[conferenceId];
    if (memberLevels && typeof memberLevels === 'object') {
      const level = Number((memberLevels as Record<string, unknown>)[String(source.speakerUserId)]);
      if (Number.isFinite(level)) volume *= clampUnit(level);
    }
  }
  if (source.appType === 'feed' && source.appId !== undefined) {
    const stopped = parseStorageObject(storage[`stoppedFeeds:user:${userId}`]);
    if (stopped[`feed-${source.appId}`]) muted = true;
  }
  return muted ? 0 : clampUnit(volume);
}

/** Applies a Companion `api-target-audio-command` and returns the new state. */
export function applyTargetAudioCommand(
  states: Map<string, TargetAudioState>,
  command: BridgeTargetAudioCommandPayload,
): TargetAudioState {
  const key = targetAudioKey(command.targetType, Number(command.targetId));
  if (!key) throw new Error('target-not-available');
  const previous = states.get(key) ?? {
    targetType: command.targetType,
    targetId: Number(command.targetId),
    volume: DEFAULT_TARGET_VOLUME,
    muted: false,
  };
  const next = { ...previous };
  if (command.action === 'volume-up' || command.action === 'volume-down') {
    const requested = Number(command.step);
    const step = Math.max(0.01, Math.min(1, Number.isFinite(requested) ? requested : DEFAULT_VOLUME_STEP));
    next.volume = clampUnit(previous.volume + (command.action === 'volume-up' ? step : -step));
  } else if (command.action === 'mute-toggle') {
    next.muted = !previous.muted;
  } else {
    throw new Error('unsupported-action');
  }
  states.set(key, next);
  return next;
}

function parseStorageObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Linear factor of a talktome port level: -40..+40 dB, 0 when muted. */
export function portLevelGain(level: { gainDb?: unknown; muted?: unknown } | undefined): number {
  if (!level) return 1;
  if (level.muted === true) return 0;
  const gainDb = Number(level.gainDb);
  if (!Number.isFinite(gainDb)) return 1;
  return 10 ** (Math.max(-40, Math.min(40, gainDb)) / 20);
}
