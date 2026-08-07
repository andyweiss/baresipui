import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  TalktomeAccountMapping,
  TalktomeAccountMappingInput,
  TalktomeBridgeConfig,
  TalktomeEndpointKind,
  TalktomePttConfig,
  TalktomeTallyConfig,
  TalktomeTarget,
} from '~/types';

export type {
  TalktomeAccountMapping,
  TalktomeAccountMappingInput,
  TalktomeBridgeConfig,
  TalktomeEndpointKind,
  TalktomePttConfig,
  TalktomePttMode,
  TalktomeTallyConfig,
  TalktomeTarget,
  TalktomeTargetType,
} from '~/types';

export const TALKTOME_ACCOUNT_DEFAULTS = Object.freeze({
  enabled: false,
  pttMode: 'audio-level' as const,
  thresholdDb: -45,
  holdMs: 300,
  gpi: 1,
  mixLocalCallers: true,
  bitrateBps: 64_000,
  previousAudioSource: '',
  previousAudioPlayer: '',
});

const DEFAULT_CONFIG_PATH = '/config/talktome-bridge.json';
const MAX_DEVICE_VALUE_LENGTH = 512;
const MAX_CONTEXT_KEY_LENGTH = 120;

export class TalktomeConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid talktome bridge config: ${issues.join('; ')}`);
    this.name = 'TalktomeConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Canonicalizes the account keys used by baresip's state and accounts file.
 * Display-name wrappers are accepted, while URI headers and non-SIP schemes
 * are rejected because they do not identify a configured account.
 */
export function normalizeAccountUri(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('Account URI must be a string');
  }

  let candidate = value.trim();
  const wrapped = candidate.match(/<\s*(sip:[^>]*)\s*>/i);
  if (wrapped) candidate = wrapped[1].trim();
  if (!candidate) throw new Error('Account URI is required');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `sip:${candidate}`;
  if (!candidate.toLowerCase().startsWith('sip:')) {
    throw new Error('Account URI must use the sip scheme');
  }
  if (candidate.includes('?')) {
    throw new Error('Account URI headers are not supported');
  }

  const rest = candidate.slice(candidate.indexOf(':') + 1);
  const [address, ...rawParameters] = rest.split(';');
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    throw new Error('Account URI must contain user and host parts');
  }

  const user = address.slice(0, at).trim();
  const host = address.slice(at + 1).trim();
  if (
    !user ||
    !host ||
    /[\s<>"\\]/.test(user) ||
    /[\s<>"\\/@]/.test(host) ||
    !validSipHost(host)
  ) {
    throw new Error('Account URI contains invalid characters');
  }

  const parameters = rawParameters
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 0) return entry.toLowerCase();
      const key = entry.slice(0, separator).trim().toLowerCase();
      const parameterValue = entry.slice(separator + 1).trim();
      if (!key || !parameterValue || /[\s;]/.test(key + parameterValue)) {
        throw new Error('Account URI contains an invalid parameter');
      }
      return `${key}=${parameterValue.toLowerCase()}`;
    })
    .sort();

  return `sip:${user.toLowerCase()}@${host.toLowerCase()}${
    parameters.length ? `;${parameters.join(';')}` : ''
  }`;
}

export function validateTalktomeBridgeConfig(value: unknown): TalktomeBridgeConfig {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new TalktomeConfigValidationError(['root must be an object']);
  }
  rejectUnknownKeys(value, ['accounts'], 'root', issues);
  if (!isRecord(value.accounts)) {
    throw new TalktomeConfigValidationError([...issues, 'accounts must be an object']);
  }

  const accounts: Record<string, TalktomeAccountMapping> = {};
  const contextKeys = new Map<string, string>();
  const userIds = new Map<number, string>();
  const feedIds = new Map<number, string>();
  for (const [rawUri, rawMapping] of Object.entries(value.accounts)) {
    let accountUri: string;
    try {
      accountUri = normalizeAccountUri(rawUri);
    } catch (error) {
      issues.push(`accounts.${rawUri}: ${errorMessage(error)}`);
      continue;
    }
    if (accounts[accountUri]) {
      issues.push(`accounts contains duplicate normalized URI ${accountUri}`);
      continue;
    }

    const mapping = normalizeMapping(rawMapping, `accounts.${rawUri}`, issues);
    if (!mapping) continue;
    const keyOwner = contextKeys.get(mapping.key);
    if (keyOwner) {
      issues.push(
        `accounts.${rawUri}.key duplicates context key ${mapping.key} used by ${keyOwner}`,
      );
    } else {
      contextKeys.set(mapping.key, accountUri);
    }
    if (isFeedMapping(mapping)) {
      const feedOwner = feedIds.get(mapping.talktomeFeedId);
      if (feedOwner) {
        issues.push(
          `accounts.${rawUri}.talktomeFeedId duplicates ${mapping.talktomeFeedId} used by ${feedOwner}`,
        );
      } else {
        feedIds.set(mapping.talktomeFeedId, accountUri);
      }
    } else {
      const userOwner = userIds.get(mapping.talktomeUserId);
      if (userOwner) {
        issues.push(
          `accounts.${rawUri}.talktomeUserId duplicates ${mapping.talktomeUserId} used by ${userOwner}`,
        );
      } else {
        userIds.set(mapping.talktomeUserId, accountUri);
      }
    }
    accounts[accountUri] = mapping;
  }

  if (issues.length) throw new TalktomeConfigValidationError(issues);
  return { accounts };
}

/**
 * Persisted config manager with validated reads and serialized, same-directory
 * atomic replacement. Getters return copies so callers cannot mutate state
 * without validation and persistence.
 */
export class TalktomeBridgeConfigManager {
  private config: TalktomeBridgeConfig = { accounts: {} };
  private loaded = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    readonly configPath: string =
      process.env.TALKTOME_BRIDGE_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH,
  ) {
    if (!path.isAbsolute(configPath)) {
      throw new Error('Talktome bridge config path must be absolute');
    }
  }

  async load(): Promise<TalktomeBridgeConfig> {
    return this.serialized(async () => {
      if (this.loaded) return cloneConfig(this.config);
      try {
        const contents = await fs.readFile(this.configPath, 'utf8');
        this.config = validateTalktomeBridgeConfig(JSON.parse(contents) as unknown);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          this.config = { accounts: {} };
          await this.writeAtomic(this.config);
        } else if (error instanceof SyntaxError) {
          throw new TalktomeConfigValidationError([
            `file is not valid JSON: ${error.message}`,
          ]);
        } else {
          throw error;
        }
      }
      this.loaded = true;
      return cloneConfig(this.config);
    });
  }

  /**
   * Reads an existing config without creating a default file. This is used by
   * the global-disable recovery path, where absence must remain a hard no-op.
   */
  async loadIfExists(): Promise<TalktomeBridgeConfig | undefined> {
    return this.serialized(async () => {
      if (this.loaded) return cloneConfig(this.config);
      let contents: string;
      try {
        contents = await fs.readFile(this.configPath, 'utf8');
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
      }
      try {
        this.config = validateTalktomeBridgeConfig(
          JSON.parse(contents) as unknown,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new TalktomeConfigValidationError([
            `file is not valid JSON: ${error.message}`,
          ]);
        }
        throw error;
      }
      this.loaded = true;
      return cloneConfig(this.config);
    });
  }

  async reload(): Promise<TalktomeBridgeConfig> {
    return this.serialized(async () => {
      const contents = await fs.readFile(this.configPath, 'utf8');
      this.config = validateTalktomeBridgeConfig(JSON.parse(contents) as unknown);
      this.loaded = true;
      return cloneConfig(this.config);
    });
  }

  getConfig(): TalktomeBridgeConfig {
    return cloneConfig(this.config);
  }

  getAccount(accountUri: string): TalktomeAccountMapping | undefined {
    const mapping = this.config.accounts[normalizeAccountUri(accountUri)];
    return mapping ? cloneMapping(mapping) : undefined;
  }

  getEnabledAccounts(): Array<[string, TalktomeAccountMapping]> {
    return Object.entries(this.config.accounts)
      .filter(([, mapping]) => mapping.enabled)
      .map(([uri, mapping]) => [uri, cloneMapping(mapping)]);
  }

  async setAccount(
    accountUri: string,
    input: TalktomeAccountMappingInput,
  ): Promise<TalktomeAccountMapping> {
    return this.serialized(async () => {
      this.assertLoaded();
      const uri = normalizeAccountUri(accountUri);
      const mapping = validateInputMapping(input, uri);
      const next = cloneConfig(this.config);
      next.accounts[uri] = mapping;
      const validated = validateTalktomeBridgeConfig(next);
      await this.writeAtomic(validated);
      this.config = validated;
      return cloneMapping(validated.accounts[uri]);
    });
  }

  async setAccountEnabled(accountUri: string, enabled: boolean): Promise<void> {
    return this.serialized(async () => {
      this.assertLoaded();
      const uri = normalizeAccountUri(accountUri);
      const current = this.config.accounts[uri];
      if (!current) throw new Error(`No talktome mapping exists for ${uri}`);
      const next = cloneConfig(this.config);
      next.accounts[uri] = { ...cloneMapping(current), enabled };
      const validated = validateTalktomeBridgeConfig(next);
      await this.writeAtomic(validated);
      this.config = validated;
    });
  }

  async setPreviousAudioDevices(
    accountUri: string,
    previousAudioSource: string,
    previousAudioPlayer: string,
  ): Promise<void> {
    return this.serialized(async () => {
      this.assertLoaded();
      const uri = normalizeAccountUri(accountUri);
      const current = this.config.accounts[uri];
      if (!current) throw new Error(`No talktome mapping exists for ${uri}`);
      const next = cloneConfig(this.config);
      next.accounts[uri] = {
        ...cloneMapping(current),
        previousAudioSource: validateDeviceValue(previousAudioSource, 'previousAudioSource'),
        previousAudioPlayer: validateDeviceValue(previousAudioPlayer, 'previousAudioPlayer'),
      };
      const validated = validateTalktomeBridgeConfig(next);
      await this.writeAtomic(validated);
      this.config = validated;
    });
  }

  async removeAccount(accountUri: string): Promise<boolean> {
    return this.serialized(async () => {
      this.assertLoaded();
      const uri = normalizeAccountUri(accountUri);
      if (!this.config.accounts[uri]) return false;
      const next = cloneConfig(this.config);
      delete next.accounts[uri];
      await this.writeAtomic(next);
      this.config = next;
      return true;
    });
  }

  /**
   * Journal recovery primitive. Unlike the ordinary CRUD methods this always
   * rewrites the snapshot, even when in-memory state already matches, because
   * a prior atomic rename may have succeeded before its durability step failed.
   */
  async restoreAccountSnapshot(
    accountUri: string,
    mapping: TalktomeAccountMapping | undefined,
  ): Promise<void> {
    return this.serialized(async () => {
      this.assertLoaded();
      const uri = normalizeAccountUri(accountUri);
      const next = cloneConfig(this.config);
      if (mapping) next.accounts[uri] = cloneMapping(mapping);
      else delete next.accounts[uri];
      const validated = validateTalktomeBridgeConfig(next);
      await this.writeAtomic(validated);
      this.config = validated;
    });
  }

  async replace(value: unknown): Promise<TalktomeBridgeConfig> {
    return this.serialized(async () => {
      const next = validateTalktomeBridgeConfig(value);
      await this.writeAtomic(next);
      this.config = next;
      this.loaded = true;
      return cloneConfig(next);
    });
  }

  async save(): Promise<void> {
    return this.serialized(async () => {
      this.assertLoaded();
      await this.writeAtomic(this.config);
    });
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('Talktome bridge config must be loaded before it is modified');
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeAtomic(config: TalktomeBridgeConfig): Promise<void> {
    const directory = path.dirname(this.configPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.configPath)}.${process.pid}.${Date.now()}.${
        Math.random().toString(16).slice(2)
      }.tmp`,
    );

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.configPath);
      await fs.chmod(this.configPath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

let singleton: TalktomeBridgeConfigManager | undefined;

export function getTalktomeBridgeConfigManager(
  configPath?: string,
): TalktomeBridgeConfigManager {
  const requestedPath =
    configPath?.trim() ||
    process.env.TALKTOME_BRIDGE_CONFIG_PATH?.trim() ||
    DEFAULT_CONFIG_PATH;
  if (singleton && singleton.configPath !== requestedPath) {
    throw new Error(
      `Talktome bridge config manager is already using ${singleton.configPath}`,
    );
  }
  singleton ??= new TalktomeBridgeConfigManager(requestedPath);
  return singleton;
}

export function isFeedMapping(
  mapping: TalktomeAccountMapping,
): mapping is TalktomeAccountMapping & {
  endpointKind: 'feed';
  talktomeFeedId: number;
  target: null;
} {
  return mapping.endpointKind === 'feed';
}

function normalizeMapping(
  value: unknown,
  location: string,
  issues: string[],
): TalktomeAccountMapping | undefined {
  if (!isRecord(value)) {
    issues.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
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
    ],
    location,
    issues,
  );

  const endpointKind = normalizeEndpointKind(
    value.endpointKind,
    `${location}.endpointKind`,
    issues,
  );
  const userId = positiveInteger(value.talktomeUserId);
  const feedId = positiveInteger(value.talktomeFeedId);
  if (endpointKind === 'user' && !userId) {
    issues.push(`${location}.talktomeUserId must be a positive integer`);
  }
  if (endpointKind === 'feed' && !feedId) {
    issues.push(`${location}.talktomeFeedId must be a positive integer`);
  }
  if (endpointKind === 'user' && value.talktomeFeedId !== undefined) {
    issues.push(`${location}.talktomeFeedId is only supported for feed endpoints`);
  }
  if (endpointKind === 'feed' && value.talktomeUserId !== undefined) {
    issues.push(`${location}.talktomeUserId is only supported for user endpoints`);
  }

  const defaultKey =
    endpointKind === 'feed'
      ? feedId
        ? `feed-${feedId}`
        : ''
      : userId
        ? String(userId)
        : '';
  let key = value.key === undefined ? defaultKey : '';
  if (value.key !== undefined) {
    if (typeof value.key === 'string') key = value.key.trim();
    else issues.push(`${location}.key must be a string`);
  }
  if (
    !key ||
    key.length > MAX_CONTEXT_KEY_LENGTH ||
    !/^[A-Za-z0-9_.:@-]+$/.test(key)
  ) {
    issues.push(
      `${location}.key must be 1-${MAX_CONTEXT_KEY_LENGTH} command-safe characters`,
    );
  }

  const target =
    endpointKind === 'feed'
      ? normalizeFeedTarget(value.target, `${location}.target`, issues)
      : normalizeTarget(value.target, `${location}.target`, issues);
  const ptt = normalizePtt(value.ptt, `${location}.ptt`, issues);
  const tally = normalizeTally(value.tally, `${location}.tally`, issues);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    issues.push(`${location}.enabled must be a boolean`);
  }
  if (
    value.mixLocalCallers !== undefined &&
    typeof value.mixLocalCallers !== 'boolean'
  ) {
    issues.push(`${location}.mixLocalCallers must be a boolean`);
  }
  const bitrateBps =
    value.bitrateBps === undefined
      ? TALKTOME_ACCOUNT_DEFAULTS.bitrateBps
      : finiteInteger(value.bitrateBps);
  if (bitrateBps === undefined || bitrateBps < 6_000 || bitrateBps > 510_000) {
    issues.push(`${location}.bitrateBps must be an integer between 6000 and 510000`);
  }

  let previousAudioSource = '';
  let previousAudioPlayer = '';
  try {
    previousAudioSource = validateDeviceValue(
      value.previousAudioSource ?? TALKTOME_ACCOUNT_DEFAULTS.previousAudioSource,
      `${location}.previousAudioSource`,
    );
    previousAudioPlayer = validateDeviceValue(
      value.previousAudioPlayer ?? TALKTOME_ACCOUNT_DEFAULTS.previousAudioPlayer,
      `${location}.previousAudioPlayer`,
    );
  } catch (error) {
    issues.push(errorMessage(error));
  }

  if (
    endpointKind === undefined ||
    (endpointKind === 'user' && userId === undefined) ||
    (endpointKind === 'feed' && feedId === undefined) ||
    !key ||
    target === undefined ||
    !ptt ||
    !tally ||
    bitrateBps === undefined
  ) {
    return undefined;
  }

  return {
    enabled:
      value.enabled === undefined
        ? TALKTOME_ACCOUNT_DEFAULTS.enabled
        : typeof value.enabled === 'boolean'
          ? value.enabled
          : TALKTOME_ACCOUNT_DEFAULTS.enabled,
    key,
    endpointKind,
    ...(endpointKind === 'feed'
      ? { talktomeFeedId: feedId as number, target: null }
      : { talktomeUserId: userId as number, target: target as TalktomeTarget }),
    ptt,
    tally,
    mixLocalCallers:
      value.mixLocalCallers === undefined
        ? TALKTOME_ACCOUNT_DEFAULTS.mixLocalCallers
        : typeof value.mixLocalCallers === 'boolean'
          ? value.mixLocalCallers
          : TALKTOME_ACCOUNT_DEFAULTS.mixLocalCallers,
    bitrateBps,
    previousAudioSource,
    previousAudioPlayer,
  };
}

function validateInputMapping(
  input: TalktomeAccountMappingInput,
  accountUri: string,
): TalktomeAccountMapping {
  const endpointKind = input.endpointKind ?? 'user';
  const raw: Record<string, unknown> = {
    ...input,
    endpointKind,
    key:
      input.key ??
      (endpointKind === 'feed'
        ? input.talktomeFeedId === undefined
          ? undefined
          : `feed-${input.talktomeFeedId}`
        : input.talktomeUserId === undefined
          ? undefined
          : String(input.talktomeUserId)),
    ptt: {
      mode: input.ptt?.mode ?? TALKTOME_ACCOUNT_DEFAULTS.pttMode,
      thresholdDb: input.ptt?.thresholdDb ?? TALKTOME_ACCOUNT_DEFAULTS.thresholdDb,
      holdMs: input.ptt?.holdMs ?? TALKTOME_ACCOUNT_DEFAULTS.holdMs,
      gpi: input.ptt?.gpi ?? TALKTOME_ACCOUNT_DEFAULTS.gpi,
    },
    tally: input.tally ?? {},
  };
  const issues: string[] = [];
  const mapping = normalizeMapping(raw, `accounts.${accountUri}`, issues);
  if (!mapping || issues.length) throw new TalktomeConfigValidationError(issues);
  return mapping;
}

function normalizeEndpointKind(
  value: unknown,
  location: string,
  issues: string[],
): TalktomeEndpointKind | undefined {
  if (value === undefined) return 'user';
  if (value === 'user' || value === 'feed') return value;
  issues.push(`${location} must be user or feed`);
  return undefined;
}

function normalizeTarget(
  value: unknown,
  location: string,
  issues: string[],
): TalktomeTarget | undefined {
  if (!isRecord(value)) {
    issues.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['type', 'id'], location, issues);
  if (value.type !== 'conference' && value.type !== 'user') {
    issues.push(`${location}.type must be conference or user`);
  }
  const id = positiveInteger(value.id);
  if (!id) issues.push(`${location}.id must be a positive integer`);
  return (value.type === 'conference' || value.type === 'user') && id
    ? { type: value.type, id }
    : undefined;
}

function normalizeFeedTarget(
  value: unknown,
  location: string,
  issues: string[],
): null | undefined {
  if (value === undefined || value === null) return null;
  issues.push(`${location} must be null for feed endpoints`);
  return undefined;
}

function normalizePtt(
  value: unknown,
  location: string,
  issues: string[],
): TalktomePttConfig | undefined {
  if (value === undefined) value = {};
  if (!isRecord(value)) {
    issues.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['mode', 'thresholdDb', 'holdMs', 'gpi'], location, issues);
  const mode = value.mode ?? TALKTOME_ACCOUNT_DEFAULTS.pttMode;
  const thresholdDb =
    value.thresholdDb === undefined
      ? TALKTOME_ACCOUNT_DEFAULTS.thresholdDb
      : typeof value.thresholdDb === 'number'
        ? value.thresholdDb
        : Number.NaN;
  const holdMs = finiteInteger(
    value.holdMs === undefined
      ? TALKTOME_ACCOUNT_DEFAULTS.holdMs
      : value.holdMs,
  );
  const gpi = optionalGpo(
    value.gpi === undefined ? TALKTOME_ACCOUNT_DEFAULTS.gpi : value.gpi,
  );
  if (mode !== 'audio-level' && mode !== 'external') {
    issues.push(`${location}.mode must be audio-level or external`);
  }
  if (!Number.isFinite(thresholdDb) || thresholdDb < -120 || thresholdDb > -10) {
    issues.push(`${location}.thresholdDb must be between -120 and -10`);
  }
  if (holdMs === undefined || holdMs < 0 || holdMs > 60_000) {
    issues.push(`${location}.holdMs must be an integer between 0 and 60000`);
  }
  if (gpi === undefined) {
    issues.push(`${location}.gpi must be an integer from 1 to 6`);
  }
  return (mode === 'audio-level' || mode === 'external') &&
    Number.isFinite(thresholdDb) &&
    holdMs !== undefined &&
    gpi !== undefined
    ? { mode, thresholdDb, holdMs, gpi }
    : undefined;
}

function normalizeTally(
  value: unknown,
  location: string,
  issues: string[],
): TalktomeTallyConfig | undefined {
  if (value === undefined) value = {};
  if (!isRecord(value)) {
    issues.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['activeGpo', 'liveGpo'], location, issues);
  const activeGpo = optionalGpo(value.activeGpo);
  const liveGpo = optionalGpo(value.liveGpo);
  if (value.activeGpo !== undefined && activeGpo === undefined) {
    issues.push(`${location}.activeGpo must be an integer from 1 to 6`);
  }
  if (value.liveGpo !== undefined && liveGpo === undefined) {
    issues.push(`${location}.liveGpo must be an integer from 1 to 6`);
  }
  if (activeGpo !== undefined && activeGpo === liveGpo) {
    issues.push(`${location} activeGpo and liveGpo must be different`);
  }
  return {
    ...(activeGpo !== undefined ? { activeGpo } : {}),
    ...(liveGpo !== undefined ? { liveGpo } : {}),
  };
}

function validateDeviceValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > MAX_DEVICE_VALUE_LENGTH || /[;\r\n\0]/.test(value)) {
    throw new Error(`${label} is too long or contains control characters`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
  issues: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${location}.${key} is not supported`);
  }
}

function optionalGpo(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = finiteInteger(value);
  return number !== undefined && number >= 1 && number <= 6 ? number : undefined;
}

function validSipHost(value: string): boolean {
  const ipv6 = value.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i);
  if (ipv6) return validOptionalPort(ipv6[2]);
  const hostname = value.match(/^([^:]+)(?::(\d+))?$/);
  if (!hostname || !/^[a-z0-9._-]+$/i.test(hostname[1])) return false;
  return validOptionalPort(hostname[2]);
}

function validOptionalPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
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

function cloneMapping(mapping: TalktomeAccountMapping): TalktomeAccountMapping {
  return {
    ...mapping,
    target: mapping.target ? { ...mapping.target } : null,
    ptt: { ...mapping.ptt },
    tally: { ...mapping.tally },
  };
}

function cloneConfig(config: TalktomeBridgeConfig): TalktomeBridgeConfig {
  return {
    accounts: Object.fromEntries(
      Object.entries(config.accounts).map(([uri, mapping]) => [uri, cloneMapping(mapping)]),
    ),
  };
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
