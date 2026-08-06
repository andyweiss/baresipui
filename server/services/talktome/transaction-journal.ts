import fs from 'node:fs/promises';
import path from 'node:path';
import type { TalktomeAccountMapping } from '~/types';
import { withAccountAudioTransaction } from '../accounts-file';
import {
  normalizeAccountUri,
  type TalktomeBridgeConfigManager,
  validateTalktomeBridgeConfig,
} from '../talktome-bridge-config';

interface PreviousAudioSnapshot {
  audioSource: string;
  audioPlayer: string;
  audioSourcePresent: boolean;
  audioPlayerPresent: boolean;
}

export interface TalktomeMappingJournalEntry {
  version: 1;
  operation: 'put' | 'delete';
  accountUri: string;
  previousMapping: TalktomeAccountMapping | null;
  expectedMapping: TalktomeAccountMapping | null;
  previousAudio: PreviousAudioSnapshot | null;
  expectedAudio: PreviousAudioSnapshot | null;
}

export interface TalktomeMappingJournal {
  prepare(entry: Omit<TalktomeMappingJournalEntry, 'version'>): Promise<void>;
}

const journalOperations = new Map<string, Promise<void>>();

/**
 * Runs one account/config mutation under the single durable journal associated
 * with the mapping file. Any ordinary failure is rolled back immediately; a
 * crash leaves the journal for startup recovery.
 */
export function withTalktomeMappingJournal<T>(
  manager: TalktomeBridgeConfigManager,
  accountsPath: string,
  operation: (journal: TalktomeMappingJournal) => Promise<T>,
): Promise<T> {
  return serializedJournalOperation(manager.configPath, async () => {
    await recoverJournal(manager, accountsPath);
    let prepared = false;
    try {
      const result = await operation({
        prepare: async (entry) => {
          if (prepared) throw new Error('Talktome mapping journal is already prepared');
          const validated = validateJournalEntry({ ...entry, version: 1 });
          await writeJournalAtomic(manager.configPath, validated);
          prepared = true;
        },
      });
      if (!prepared) {
        throw new Error('Talktome mapping mutation did not prepare its journal');
      }
      await removeJournal(manager.configPath);
      return result;
    } catch (error) {
      try {
        await recoverJournal(manager, accountsPath);
      } catch (recoveryError) {
        const combined = new Error(
          'Talktome mapping mutation and journal recovery both failed',
        ) as Error & { errors: unknown[] };
        combined.errors = [error, recoveryError];
        throw combined;
      }
      throw error;
    }
  });
}

/**
 * Replays a left-over write-ahead journal only while each persisted field is
 * still at the expected post-mutation value (or was already restored). A
 * divergent value is treated as an operator change and leaves the journal in
 * place without overwriting either file.
 */
export function recoverTalktomeMappingJournal(
  manager: TalktomeBridgeConfigManager,
  accountsPath: string,
): Promise<boolean> {
  return serializedJournalOperation(manager.configPath, () =>
    recoverJournal(manager, accountsPath),
  );
}

async function recoverJournal(
  manager: TalktomeBridgeConfigManager,
  accountsPath: string,
): Promise<boolean> {
  const entry = await readJournal(manager.configPath);
  if (!entry) return false;

  await withAccountAudioTransaction(accountsPath, async (transaction) => {
    let restoreAudio = false;
    if (entry.previousAudio && entry.expectedAudio) {
      const account = transaction.getAccountAudioDevices(entry.accountUri);
      if (!account) {
        throw new Error(
          `Cannot recover talktome journal because SIP account ${entry.accountUri} is missing`,
        );
      }
      if (
        !audioFieldRecoverable(
          account.audioSource,
          account.audioSourcePresent,
          entry.expectedAudio.audioSource,
          entry.expectedAudio.audioSourcePresent,
          entry.previousAudio.audioSource,
          entry.previousAudio.audioSourcePresent,
        ) ||
        !audioFieldRecoverable(
          account.audioPlayer,
          account.audioPlayerPresent,
          entry.expectedAudio.audioPlayer,
          entry.expectedAudio.audioPlayerPresent,
          entry.previousAudio.audioPlayer,
          entry.previousAudio.audioPlayerPresent,
        )
      ) {
        throw new Error(
          `Cannot recover talktome journal because SIP account ${entry.accountUri} has divergent audio settings; journal retained for operator review`,
        );
      }
      restoreAudio = !audioSnapshotEquals(account, entry.previousAudio);
    }

    await manager.reload();
    const currentMapping = manager.getAccount(entry.accountUri) ?? null;
    if (
      !mappingEquals(currentMapping, entry.expectedMapping) &&
      !mappingEquals(currentMapping, entry.previousMapping)
    ) {
      throw new Error(
        `Cannot recover talktome journal because mapping ${entry.accountUri} has diverged; journal retained for operator review`,
      );
    }

    if (restoreAudio) {
      transaction.setAccountAudioDevices(entry.accountUri, {
        audioSource: entry.previousAudio!.audioSourcePresent
          ? entry.previousAudio!.audioSource
          : null,
        audioPlayer: entry.previousAudio!.audioPlayerPresent
          ? entry.previousAudio!.audioPlayer
          : null,
      });
      await transaction.commit();
    }
    if (!mappingEquals(currentMapping, entry.previousMapping)) {
      await manager.restoreAccountSnapshot(
        entry.accountUri,
        entry.previousMapping ?? undefined,
      );
    }
  });
  await removeJournal(manager.configPath);
  return true;
}

function serializedJournalOperation<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(configPath);
  const previous = journalOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const queued = result.then(
    () => undefined,
    () => undefined,
  );
  journalOperations.set(key, queued);
  return result.finally(() => {
    if (journalOperations.get(key) === queued) {
      journalOperations.delete(key);
    }
  });
}

async function readJournal(
  configPath: string,
): Promise<TalktomeMappingJournalEntry | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(journalPath(configPath), 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return validateJournalEntry(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new Error(`Invalid talktome transaction journal: ${errorMessage(error)}`);
  }
}

function validateJournalEntry(value: unknown): TalktomeMappingJournalEntry {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('journal version must be 1');
  }
  requireExactKeys(
    value,
    [
      'version',
      'operation',
      'accountUri',
      'previousMapping',
      'expectedMapping',
      'previousAudio',
      'expectedAudio',
    ],
    'journal',
  );
  if (value.operation !== 'put' && value.operation !== 'delete') {
    throw new Error('journal operation must be put or delete');
  }
  const accountUri = normalizeAccountUri(requiredString(value.accountUri, 'accountUri'));
  const previousMapping = validateJournalMapping(
    value.previousMapping,
    accountUri,
    'previousMapping',
  );
  const expectedMapping = validateJournalMapping(
    value.expectedMapping,
    accountUri,
    'expectedMapping',
  );
  if (value.operation === 'put' && expectedMapping === null) {
    throw new Error('PUT journal expectedMapping must be an object');
  }
  if (value.operation === 'delete' && previousMapping === null) {
    throw new Error('DELETE journal previousMapping must be an object');
  }
  if (value.operation === 'delete' && expectedMapping !== null) {
    throw new Error('DELETE journal expectedMapping must be null');
  }
  const previousAudio = validateAudioSnapshot(value.previousAudio, 'previousAudio');
  const expectedAudio = validateAudioSnapshot(value.expectedAudio, 'expectedAudio');
  if ((previousAudio === null) !== (expectedAudio === null)) {
    throw new Error('previousAudio and expectedAudio must both be null or objects');
  }
  if (value.operation === 'put' && expectedAudio === null) {
    throw new Error('PUT journal expectedAudio must be an object');
  }
  return {
    version: 1,
    operation: value.operation,
    accountUri,
    previousMapping,
    expectedMapping,
    previousAudio,
    expectedAudio,
  };
}

function validateJournalMapping(
  value: unknown,
  accountUri: string,
  label: string,
): TalktomeAccountMapping | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null`);
  const mappingKeys = [
    'enabled',
    'key',
    'endpointKind',
    'talktomeUserId',
    'talktomeFeedId',
    'target',
    'ptt',
    'tally',
    'mixLocalCallers',
    'bitrateBps',
    'previousAudioSource',
    'previousAudioPlayer',
  ] as const;
  requireAllowedKeys(value, mappingKeys, label);
  // endpointKind is optional for journals written before feed mappings existed;
  // missing values are treated as legacy user mappings (same as config normalize).
  for (const key of [
    'enabled',
    'key',
    'target',
    'ptt',
    'tally',
    'mixLocalCallers',
    'bitrateBps',
    'previousAudioSource',
    'previousAudioPlayer',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
  if (
    value.endpointKind !== undefined &&
    value.endpointKind !== 'user' &&
    value.endpointKind !== 'feed'
  ) {
    throw new Error(`${label}.endpointKind must be user or feed`);
  }
  if (
    value.endpointKind === 'feed' &&
    !Object.prototype.hasOwnProperty.call(value, 'talktomeFeedId')
  ) {
    throw new Error(`${label}.talktomeFeedId is required`);
  }
  if (
    value.endpointKind !== 'feed' &&
    !Object.prototype.hasOwnProperty.call(value, 'talktomeUserId')
  ) {
    throw new Error(`${label}.talktomeUserId is required`);
  }
  if (value.endpointKind === 'feed') {
    if (value.target !== null) throw new Error(`${label}.target must be null`);
  } else {
    if (!isRecord(value.target)) throw new Error(`${label}.target must be an object`);
    requireExactKeys(value.target, ['type', 'id'], `${label}.target`);
  }
  if (!isRecord(value.ptt)) throw new Error(`${label}.ptt must be an object`);
  requireExactKeys(
    value.ptt,
    ['mode', 'thresholdDb', 'holdMs', 'gpi'],
    `${label}.ptt`,
  );
  if (!isRecord(value.tally)) throw new Error(`${label}.tally must be an object`);
  requireAllowedKeys(
    value.tally,
    ['activeGpo', 'liveGpo'],
    `${label}.tally`,
  );
  return validateTalktomeBridgeConfig({
    accounts: { [accountUri]: value },
  }).accounts[accountUri];
}

function validateAudioSnapshot(
  value: unknown,
  label: string,
): PreviousAudioSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null`);
  requireExactKeys(
    value,
    [
      'audioSource',
      'audioPlayer',
      'audioSourcePresent',
      'audioPlayerPresent',
    ],
    label,
  );
  const snapshot = {
    audioSource: safeDeviceValue(value.audioSource, `${label}.audioSource`),
    audioPlayer: safeDeviceValue(value.audioPlayer, `${label}.audioPlayer`),
    audioSourcePresent: requiredBoolean(
      value.audioSourcePresent,
      `${label}.audioSourcePresent`,
    ),
    audioPlayerPresent: requiredBoolean(
      value.audioPlayerPresent,
      `${label}.audioPlayerPresent`,
    ),
  };
  if (!snapshot.audioSourcePresent && snapshot.audioSource !== '') {
    throw new Error(`${label}.audioSource must be empty when absent`);
  }
  if (!snapshot.audioPlayerPresent && snapshot.audioPlayer !== '') {
    throw new Error(`${label}.audioPlayer must be empty when absent`);
  }
  return snapshot;
}

function mappingEquals(
  left: TalktomeAccountMapping | null,
  right: TalktomeAccountMapping | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.enabled === right.enabled &&
    left.key === right.key &&
    left.endpointKind === right.endpointKind &&
    left.talktomeUserId === right.talktomeUserId &&
    left.talktomeFeedId === right.talktomeFeedId &&
    left.target?.type === right.target?.type &&
    left.target?.id === right.target?.id &&
    left.ptt.mode === right.ptt.mode &&
    left.ptt.thresholdDb === right.ptt.thresholdDb &&
    left.ptt.holdMs === right.ptt.holdMs &&
    left.ptt.gpi === right.ptt.gpi &&
    left.tally.activeGpo === right.tally.activeGpo &&
    left.tally.liveGpo === right.tally.liveGpo &&
    left.mixLocalCallers === right.mixLocalCallers &&
    left.bitrateBps === right.bitrateBps &&
    left.previousAudioSource === right.previousAudioSource &&
    left.previousAudioPlayer === right.previousAudioPlayer
  );
}

function audioSnapshotEquals(
  current: {
    audioSource: string;
    audioPlayer: string;
    audioSourcePresent: boolean;
    audioPlayerPresent: boolean;
  },
  snapshot: PreviousAudioSnapshot,
): boolean {
  return (
    current.audioSource === snapshot.audioSource &&
    current.audioPlayer === snapshot.audioPlayer &&
    current.audioSourcePresent === snapshot.audioSourcePresent &&
    current.audioPlayerPresent === snapshot.audioPlayerPresent
  );
}

function audioFieldRecoverable(
  currentValue: string,
  currentPresent: boolean,
  expectedValue: string,
  expectedPresent: boolean,
  previousValue: string,
  previousPresent: boolean,
): boolean {
  return (
    (currentValue === expectedValue && currentPresent === expectedPresent) ||
    (currentValue === previousValue && currentPresent === previousPresent)
  );
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

async function writeJournalAtomic(
  configPath: string,
  entry: TalktomeMappingJournalEntry,
): Promise<void> {
  const destination = journalPath(configPath);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.${
      Math.random().toString(16).slice(2)
    }.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, destination);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeJournal(configPath: string): Promise<void> {
  const destination = journalPath(configPath);
  try {
    await fs.unlink(destination);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await syncDirectory(path.dirname(destination));
}

function journalPath(configPath: string): string {
  const directory = path.dirname(configPath);
  return path.join(directory, `.${path.basename(configPath)}.transaction-journal`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function safeDeviceValue(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    /[;\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error, 'EINVAL') &&
      !isNodeError(error, 'ENOTSUP') &&
      !isNodeError(error, 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
