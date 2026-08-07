import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type TalktomeBridgeIdSource = 'env' | 'persisted' | 'generated';

export interface ResolvedTalktomeBridgeId {
  bridgeId: string;
  source: TalktomeBridgeIdSource;
  identityPath: string;
}

/**
 * Sibling of the account-mapping config, e.g.
 * `/config/talktome-bridge.json` → `/config/talktome-bridge.identity.json`.
 * Matches the official bridge-client pattern of persisting the opaque bridge
 * id across restarts (localStorage there; config volume here).
 */
export function talktomeBridgeIdentityPath(configPath: string): string {
  if (!path.isAbsolute(configPath)) {
    throw new Error('Talktome bridge config path must be absolute');
  }
  const directory = path.dirname(configPath);
  const base = path.basename(configPath, path.extname(configPath));
  return path.join(directory, `${base}.identity.json`);
}

/**
 * Resolve the stable TalkToMe bridge registration id:
 * 1. `TALKTOME_BRIDGE_ID` when set (explicit override)
 * 2. previously persisted identity next to the bridge config
 * 3. otherwise generate a UUID and persist it
 *
 * The official talktome bridge-client likewise does not require operators to
 * copy an id from Admin: first announce may omit the id (server assigns a
 * UUID) and the client stores `bridge.id` for later re-announces. We generate
 * the UUID locally up front so ctrl_tcp/runtime validation always has a
 * non-empty id before the first announce.
 */
export async function resolveTalktomeBridgeId(options: {
  configuredId: string;
  configPath: string;
}): Promise<ResolvedTalktomeBridgeId> {
  const identityPath = talktomeBridgeIdentityPath(options.configPath);
  const fromEnv = options.configuredId.trim();
  if (fromEnv) {
    await writeBridgeIdentity(identityPath, fromEnv);
    return { bridgeId: fromEnv, source: 'env', identityPath };
  }

  const persisted = await readBridgeIdentity(identityPath);
  if (persisted) {
    return { bridgeId: persisted, source: 'persisted', identityPath };
  }

  const generated = randomUUID();
  await writeBridgeIdentity(identityPath, generated);
  return { bridgeId: generated, source: 'generated', identityPath };
}

/**
 * Persist the id returned by TalkToMe announce (`bridge.id`), matching the
 * official bridge-client localStorage update after each successful announce.
 */
export async function persistAnnouncedBridgeId(options: {
  configPath: string;
  bridgeId: string;
}): Promise<string> {
  const bridgeId = options.bridgeId.trim();
  if (!bridgeId) {
    throw new Error('Announced talktome bridge id must be non-empty');
  }
  const identityPath = talktomeBridgeIdentityPath(options.configPath);
  await writeBridgeIdentity(identityPath, bridgeId);
  return bridgeId;
}

async function readBridgeIdentity(identityPath: string): Promise<string | undefined> {
  try {
    const contents = await fs.readFile(identityPath, 'utf8');
    const parsed = JSON.parse(contents) as unknown;
    if (!isRecord(parsed)) return undefined;
    const bridgeId =
      typeof parsed.bridgeId === 'string' ? parsed.bridgeId.trim() : '';
    return bridgeId || undefined;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(
        `Talktome bridge identity file is not valid JSON: ${error.message}`,
      );
    }
    throw error;
  }
}

async function writeBridgeIdentity(
  identityPath: string,
  bridgeId: string,
): Promise<void> {
  const directory = path.dirname(identityPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(identityPath)}.${process.pid}.${Date.now()}.${
      Math.random().toString(16).slice(2)
    }.tmp`,
  );

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify({ bridgeId }, null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, identityPath);
    await fs.chmod(identityPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
