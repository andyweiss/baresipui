import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  persistAnnouncedBridgeId,
  resolveTalktomeBridgeId,
  talktomeBridgeIdentityPath,
} from '~/server/services/talktome/bridge-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'talktome-bridge-id-'));
  tempDirs.push(dir);
  return path.join(dir, 'talktome-bridge.json');
}

describe('talktome bridge identity', () => {
  it('maps the identity file beside the mapping config path', () => {
    expect(talktomeBridgeIdentityPath('/config/talktome-bridge.json')).toBe(
      '/config/talktome-bridge.identity.json',
    );
  });

  it('prefers TALKTOME_BRIDGE_ID and persists it for later runs', async () => {
    const configPath = await tempConfigPath();
    const first = await resolveTalktomeBridgeId({
      configuredId: ' bridge-explicit ',
      configPath,
    });
    expect(first).toMatchObject({
      bridgeId: 'bridge-explicit',
      source: 'env',
    });

    const stored = JSON.parse(
      await readFile(first.identityPath, 'utf8'),
    ) as { bridgeId: string };
    expect(stored.bridgeId).toBe('bridge-explicit');

    const second = await resolveTalktomeBridgeId({
      configuredId: '',
      configPath,
    });
    expect(second).toMatchObject({
      bridgeId: 'bridge-explicit',
      source: 'persisted',
    });
  });

  it('generates a UUID once and reuses the persisted value', async () => {
    const configPath = await tempConfigPath();
    const first = await resolveTalktomeBridgeId({
      configuredId: '',
      configPath,
    });
    expect(first.source).toBe('generated');
    expect(first.bridgeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const second = await resolveTalktomeBridgeId({
      configuredId: '',
      configPath,
    });
    expect(second).toMatchObject({
      bridgeId: first.bridgeId,
      source: 'persisted',
    });
  });

  it('updates the persisted id from a successful announce response', async () => {
    const configPath = await tempConfigPath();
    await writeFile(
      talktomeBridgeIdentityPath(configPath),
      `${JSON.stringify({ bridgeId: 'local-generated' }, null, 2)}\n`,
      'utf8',
    );

    const announced = await persistAnnouncedBridgeId({
      configPath,
      bridgeId: ' server-assigned-id ',
    });
    expect(announced).toBe('server-assigned-id');

    const resolved = await resolveTalktomeBridgeId({
      configuredId: '',
      configPath,
    });
    expect(resolved).toMatchObject({
      bridgeId: 'server-assigned-id',
      source: 'persisted',
    });
  });
});
