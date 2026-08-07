import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TALKTOME_ACCOUNT_DEFAULTS,
  TalktomeBridgeConfigManager,
  TalktomeConfigValidationError,
  normalizeAccountUri,
  validateTalktomeBridgeConfig,
} from '~/server/services/talktome-bridge-config';

const temporaryDirectories: string[] = [];

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'talktome-config-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'bridge.json');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('talktome bridge configuration', () => {
  it('canonicalizes SIP account keys and fills every account default, including gpi', () => {
    expect(
      normalizeAccountUri(
        'Alice Example <SIP:Alice@Example.COM;Transport=UDP;lr>',
      ),
    ).toBe('sip:alice@example.com;lr;transport=udp');

    const config = validateTalktomeBridgeConfig({
      accounts: {
        'Studio@Example.com': {
          talktomeUserId: 41,
          target: { type: 'conference', id: 9 },
        },
      },
    });

    expect(config).toEqual({
      accounts: {
        'sip:studio@example.com': {
          enabled: TALKTOME_ACCOUNT_DEFAULTS.enabled,
          key: '41',
          endpointKind: 'user',
          talktomeUserId: 41,
          target: { type: 'conference', id: 9 },
          ptt: {
            mode: TALKTOME_ACCOUNT_DEFAULTS.pttMode,
            thresholdDb: TALKTOME_ACCOUNT_DEFAULTS.thresholdDb,
            holdMs: TALKTOME_ACCOUNT_DEFAULTS.holdMs,
            gpi: 1,
          },
          tally: {},
          mixLocalCallers: TALKTOME_ACCOUNT_DEFAULTS.mixLocalCallers,
          bitrateBps: TALKTOME_ACCOUNT_DEFAULTS.bitrateBps,
          previousAudioSource: '',
          previousAudioPlayer: '',
        },
      },
    });
  });

  it('accepts feed mappings and tracks duplicate feed IDs separately from users', () => {
    const config = validateTalktomeBridgeConfig({
      accounts: {
        'sip:user@example.com': {
          talktomeUserId: 5,
          target: { type: 'conference', id: 9 },
        },
        'sip:feed@example.com': {
          endpointKind: 'feed',
          talktomeFeedId: 5,
        },
      },
    });

    expect(config.accounts['sip:user@example.com']).toMatchObject({
      endpointKind: 'user',
      talktomeUserId: 5,
      target: { type: 'conference', id: 9 },
    });
    expect(config.accounts['sip:feed@example.com']).toMatchObject({
      endpointKind: 'feed',
      key: 'feed-5',
      talktomeFeedId: 5,
      target: null,
      ptt: {
        mode: TALKTOME_ACCOUNT_DEFAULTS.pttMode,
        thresholdDb: TALKTOME_ACCOUNT_DEFAULTS.thresholdDb,
        holdMs: TALKTOME_ACCOUNT_DEFAULTS.holdMs,
        gpi: TALKTOME_ACCOUNT_DEFAULTS.gpi,
      },
    });

    expect(() =>
      validateTalktomeBridgeConfig({
        accounts: {
          'sip:first@example.com': {
            endpointKind: 'feed',
            talktomeFeedId: 7,
          },
          'sip:second@example.com': {
            endpointKind: 'feed',
            talktomeFeedId: 7,
          },
        },
      }),
    ).toThrow(TalktomeConfigValidationError);

    try {
      validateTalktomeBridgeConfig({
        accounts: {
          'sip:first@example.com': {
            endpointKind: 'feed',
            talktomeFeedId: 7,
          },
          'sip:second@example.com': {
            endpointKind: 'feed',
            talktomeFeedId: 7,
          },
        },
      });
    } catch (error) {
      expect((error as TalktomeConfigValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            '.talktomeFeedId duplicates 7 used by sip:first@example.com',
          ),
        ]),
      );
    }
  });

  it('rejects malformed mappings, duplicate normalized URIs, invalid gpi, and token fields', () => {
    const invalid = {
      bridgeToken: 'must-never-be-persisted',
      accounts: {
        'sip:studio@example.com': {
          enabled: 'yes',
          key: 'not command safe',
          talktomeUserId: 0,
          target: { type: 'feed', id: -1 },
          ptt: { mode: 'external', gpi: 7, holdMs: -1, thresholdDb: -5 },
          tally: { activeGpo: 2, liveGpo: 2 },
          token: 'also-forbidden',
        },
        'STUDIO@EXAMPLE.COM': {
          talktomeUserId: 42,
          target: { type: 'user', id: 42 },
        },
        'sip:dup@example.com': {
          talktomeUserId: 44,
          target: { type: 'user', id: 44 },
        },
        'DUP@EXAMPLE.COM': {
          talktomeUserId: 45,
          target: { type: 'user', id: 45 },
        },
      },
    };

    expect(() => validateTalktomeBridgeConfig(invalid)).toThrow(
      TalktomeConfigValidationError,
    );
    try {
      validateTalktomeBridgeConfig(invalid);
    } catch (error) {
      expect((error as TalktomeConfigValidationError).issues).toEqual(
        expect.arrayContaining([
          'root.bridgeToken is not supported',
          expect.stringContaining('.token is not supported'),
          expect.stringContaining('.gpi must be an integer from 1 to 6'),
          expect.stringContaining('duplicate normalized URI'),
        ]),
      );
    }

    for (const uri of [
      '',
      'https://example.com',
      'sip:missing-host@',
      'sip:user@example.com?subject=not-supported',
    ]) {
      expect(() => normalizeAccountUri(uri)).toThrow();
    }
  });

  it('rejects duplicate context keys and talktome user IDs independently', () => {
    const invalid = {
      accounts: {
        'sip:first@example.com': {
          key: 'shared',
          talktomeUserId: 41,
          target: { type: 'user', id: 41 },
        },
        'sip:second@example.com': {
          key: 'shared',
          talktomeUserId: 42,
          target: { type: 'user', id: 42 },
        },
        'sip:third@example.com': {
          key: 'third',
          talktomeUserId: 41,
          target: { type: 'user', id: 43 },
        },
      },
    };

    try {
      validateTalktomeBridgeConfig(invalid);
      throw new Error('Expected duplicate config to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(TalktomeConfigValidationError);
      expect((error as TalktomeConfigValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            '.key duplicates context key shared used by sip:first@example.com',
          ),
          expect.stringContaining(
            '.talktomeUserId duplicates 41 used by sip:first@example.com',
          ),
        ]),
      );
    }
  });

  it('does not coerce numeric strings or booleans during validation', () => {
    const validMapping = {
      enabled: true,
      key: 'studio',
      talktomeUserId: 41,
      target: { type: 'conference', id: 9 },
      ptt: { mode: 'external', thresholdDb: -45, holdMs: 300, gpi: 1 },
      tally: { activeGpo: 2, liveGpo: 3 },
      mixLocalCallers: true,
      bitrateBps: 64_000,
    };
    const invalidMappings = [
      { ...validMapping, enabled: 'true' },
      { ...validMapping, talktomeUserId: '41' },
      { ...validMapping, talktomeUserId: true },
      { ...validMapping, target: { type: 'conference', id: '9' } },
      { ...validMapping, target: { type: 'conference', id: false } },
      { ...validMapping, ptt: { ...validMapping.ptt, thresholdDb: '-45' } },
      { ...validMapping, ptt: { ...validMapping.ptt, holdMs: '300' } },
      { ...validMapping, ptt: { ...validMapping.ptt, gpi: true } },
      { ...validMapping, tally: { activeGpo: '2', liveGpo: 3 } },
      { ...validMapping, mixLocalCallers: 'true' },
      { ...validMapping, bitrateBps: '64000' },
    ];

    for (const mapping of invalidMappings) {
      expect(() =>
        validateTalktomeBridgeConfig({
          accounts: { 'sip:studio@example.com': mapping },
        }),
      ).toThrow(TalktomeConfigValidationError);
    }
  });

  it('defaults gpi to one and accepts only integer GPIO inputs 1 through 6', () => {
    const mapping = {
      talktomeUserId: 41,
      target: { type: 'conference', id: 9 },
    };
    expect(
      validateTalktomeBridgeConfig({
        accounts: { 'sip:studio@example.com': mapping },
      }).accounts['sip:studio@example.com'].ptt.gpi,
    ).toBe(1);

    for (const gpi of [1, 6]) {
      expect(
        validateTalktomeBridgeConfig({
          accounts: {
            'sip:studio@example.com': { ...mapping, ptt: { gpi } },
          },
        }).accounts['sip:studio@example.com'].ptt.gpi,
      ).toBe(gpi);
    }
    for (const gpi of [0, 7, 1.5, '1', true, null]) {
      expect(() =>
        validateTalktomeBridgeConfig({
          accounts: {
            'sip:studio@example.com': { ...mapping, ptt: { gpi } },
          },
        }),
      ).toThrow(/gpi must be an integer from 1 to 6/);
    }
  });

  it('loads, serializes concurrent atomic set/remove operations, and persists no token data', async () => {
    const configPath = await temporaryConfigPath();
    const manager = new TalktomeBridgeConfigManager(configPath);

    await expect(
      manager.setAccount('sip:early@example.com', {
        talktomeUserId: 1,
        target: { type: 'user', id: 1 },
      }),
    ).rejects.toThrow('must be loaded');

    await expect(manager.load()).resolves.toEqual({ accounts: {} });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ accounts: {} });

    await Promise.all([
      manager.setAccount('Studio@Example.com', {
        enabled: true,
        talktomeUserId: 41,
        target: { type: 'conference', id: 9 },
        ptt: { mode: 'external', gpi: 6 },
      }),
      manager.setAccount('sip:backup@example.com', {
        enabled: true,
        key: 'backup',
        talktomeUserId: 42,
        target: { type: 'user', id: 42 },
      }),
    ]);

    expect(manager.getEnabledAccounts().map(([uri]) => uri).sort()).toEqual([
      'sip:backup@example.com',
      'sip:studio@example.com',
    ]);
    expect(manager.getAccount('STUDIO@example.com')?.ptt).toMatchObject({
      mode: 'external',
      gpi: 6,
    });

    const snapshot = manager.getConfig();
    snapshot.accounts['sip:studio@example.com'].key = 'mutated-copy';
    expect(manager.getAccount('sip:studio@example.com')?.key).toBe('41');

    await expect(
      manager.setAccount(
        'sip:token@example.com',
        {
          talktomeUserId: 43,
          target: { type: 'user', id: 43 },
          token: 'forbidden',
        } as never,
      ),
    ).rejects.toThrow('.token is not supported');

    await expect(manager.removeAccount('backup@example.com')).resolves.toBe(true);
    await expect(manager.removeAccount('backup@example.com')).resolves.toBe(false);

    const persistedText = await readFile(configPath, 'utf8');
    const persisted = JSON.parse(persistedText) as {
      accounts: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(persisted.accounts)).toEqual(['sip:studio@example.com']);
    expect(persisted.accounts['sip:studio@example.com'].ptt).toMatchObject({ gpi: 6 });
    expect(persistedText.toLowerCase()).not.toContain('token');
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(configPath, '..'))).filter((name) => name.endsWith('.tmp')))
      .toEqual([]);
  });

  it('validates existing files without replacing invalid JSON', async () => {
    const configPath = await temporaryConfigPath();
    await writeFile(configPath, '{"accounts":', 'utf8');
    const manager = new TalktomeBridgeConfigManager(configPath);

    await expect(manager.load()).rejects.toThrow('file is not valid JSON');
    expect(await readFile(configPath, 'utf8')).toBe('{"accounts":');
  });
});
