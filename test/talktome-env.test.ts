import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTalktomeBridgeEnvironment } from '~/server/services/talktome/env';

const environmentNames = [
  'TALKTOME_BRIDGE_ENABLED',
  'TALKTOME_BASE_URL',
  'TALKTOME_BRIDGE_ID',
  'TALKTOME_BRIDGE_TOKEN',
  'TALKTOME_MEDIA_ANNOUNCE_IP',
  'TALKTOME_BRIDGE_CONFIG_PATH',
  'TALKTOME_BRIDGE_NAME',
  'TALKTOME_BRIDGE_AUTH_MODE',
  'TALKTOME_BRIDGE_AUTO_PROVISION',
  'TALKTOME_BRIDGE_COMMAND_TIMEOUT_MS',
  'TALKTOME_DEFAULT_AUDIO_SOURCE',
  'TALKTOME_DEFAULT_AUDIO_PLAYER',
  'TALKTOME_TESTED_VERSION',
  'TALKTOME_SERVER_VERSION',
  'ACCOUNTS_CONFIG_PATH',
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('talktome runtime environment boundary', () => {
  it('is disabled by default and reads changed process environment values at each call', () => {
    for (const name of environmentNames) vi.stubEnv(name, undefined);

    expect(readTalktomeBridgeEnvironment()).toMatchObject({
      enabled: false,
      baseUrl: '',
      bridgeId: '',
      token: '',
      configPath: '/config/talktome-bridge.json',
      accountsConfigPath: '/config/accounts',
      commandTimeoutMs: 5_000,
      testedVersion: '1.1.3',
      serverVersionOverride: '',
    });

    vi.stubEnv('TALKTOME_BRIDGE_ENABLED', 'true');
    vi.stubEnv('TALKTOME_BASE_URL', ' https://bridge.example.test/ ');
    vi.stubEnv('TALKTOME_BRIDGE_ID', ' bridge-main ');
    vi.stubEnv('TALKTOME_BRIDGE_TOKEN', 'first-secret');
    vi.stubEnv('TALKTOME_MEDIA_ANNOUNCE_IP', '192.0.2.10');
    vi.stubEnv('TALKTOME_BRIDGE_CONFIG_PATH', '/tmp/runtime-config.json');
    vi.stubEnv('ACCOUNTS_CONFIG_PATH', '/tmp/runtime-accounts');
    vi.stubEnv('TALKTOME_BRIDGE_COMMAND_TIMEOUT_MS', '1234');
    vi.stubEnv('TALKTOME_TESTED_VERSION', ' 1.1.4 ');
    vi.stubEnv('TALKTOME_SERVER_VERSION', ' 1.1.5 ');

    expect(readTalktomeBridgeEnvironment()).toMatchObject({
      enabled: true,
      baseUrl: 'https://bridge.example.test/',
      bridgeId: 'bridge-main',
      token: 'first-secret',
      mediaAnnounceIp: '192.0.2.10',
      configPath: '/tmp/runtime-config.json',
      accountsConfigPath: '/tmp/runtime-accounts',
      commandTimeoutMs: 1_234,
      testedVersion: '1.1.4',
      serverVersionOverride: '1.1.5',
    });

    vi.stubEnv('TALKTOME_BRIDGE_TOKEN', 'rotated-secret');
    vi.stubEnv('TALKTOME_BRIDGE_ENABLED', 'TRUE');
    const reread = readTalktomeBridgeEnvironment();
    expect(reread.token).toBe('rotated-secret');
    expect(reread.enabled).toBe(false);
  });

  it('keeps credential fields out of the client-visible talktome type contract', async () => {
    const publicTypes = await readFile(
      new URL('../types/index.ts', import.meta.url),
      'utf8',
    );
    const start = publicTypes.indexOf(
      'export interface TalktomeBridgeServerUserPort',
    );
    const end = publicTypes.indexOf('export interface Contact', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const publicTalktomeContract = publicTypes.slice(start, end);
    expect(publicTalktomeContract).toContain(
      'export interface TalktomeBridgeConfigResponse',
    );
    expect(publicTalktomeContract).not.toMatch(
      /\b(?:token|bridgeToken|secret|authorization)\b/i,
    );
  });
});
