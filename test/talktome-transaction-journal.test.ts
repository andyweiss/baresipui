import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAccountAudioDevicesAtomic } from '~/server/services/accounts-file';
import { TalktomeBridgeConfigManager } from '~/server/services/talktome-bridge-config';
import { recoverTalktomeMappingJournal } from '~/server/services/talktome/transaction-journal';
import { ACCOUNT_URI, makeMapping } from './helpers/talktome';

const temporaryDirectories: string[] = [];

async function makePaths(): Promise<{
  configPath: string;
  accountsPath: string;
  journalPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'talktome-journal-test-'));
  temporaryDirectories.push(directory);
  const configPath = join(directory, 'talktome-bridge.json');
  return {
    configPath,
    accountsPath: join(directory, 'accounts'),
    journalPath: join(
      dirname(configPath),
      `.${basename(configPath)}.transaction-journal`,
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('talktome mapping transaction journal recovery', () => {
  it('restores pre-PUT mapping absence and exact audio bytes, then removes the journal', async () => {
    const { configPath, accountsPath, journalPath } = await makePaths();
    const originalAccounts = [
      '# preserve this preamble',
      '"Studio"<sip:studio@example.com>;transport=udp;vendor=keep',
      '',
    ].join('\r\n');
    await writeFile(accountsPath, originalAccounts, 'utf8');
    const manager = new TalktomeBridgeConfigManager(configPath);
    await manager.load();
    const expectedMapping = makeMapping();
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        operation: 'put',
        accountUri: ACCOUNT_URI,
        previousMapping: null,
        expectedMapping,
        previousAudio: {
          audioSource: '',
          audioPlayer: '',
          audioSourcePresent: false,
          audioPlayerPresent: false,
        },
        expectedAudio: {
          audioSource: 'mediasoup,studio',
          audioPlayer: 'mediasoup,studio',
          audioSourcePresent: true,
          audioPlayerPresent: true,
        },
      })}\n`,
      'utf8',
    );

    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'mediasoup,studio',
      audioPlayer: 'mediasoup,studio',
    });
    await manager.setAccount(ACCOUNT_URI, expectedMapping);
    expect(manager.getAccount(ACCOUNT_URI)).toBeDefined();
    expect(await readFile(accountsPath, 'utf8')).not.toBe(originalAccounts);

    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).resolves.toBe(true);

    expect(manager.getAccount(ACCOUNT_URI)).toBeUndefined();
    expect(await readFile(accountsPath, 'utf8')).toBe(originalAccounts);
    await expect(access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).resolves.toBe(false);
  });

  it('restores the previous mapping and exact bridge audio after an interrupted DELETE', async () => {
    const { configPath, accountsPath, journalPath } = await makePaths();
    const mapping = makeMapping({
      previousAudioSource: 'alsa,original-in',
      previousAudioPlayer: 'alsa,original-out',
    });
    const originalAccounts = [
      '; preserve comment and CRLF',
      '"Studio"<sip:studio@example.com>;audio_source=mediasoup,studio;unknown=x;audio_player=mediasoup,studio',
      '',
    ].join('\r\n');
    await writeFile(accountsPath, originalAccounts, 'utf8');
    const manager = new TalktomeBridgeConfigManager(configPath);
    await manager.load();
    await manager.setAccount(ACCOUNT_URI, mapping);
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        operation: 'delete',
        accountUri: ACCOUNT_URI,
        previousMapping: mapping,
        expectedMapping: null,
        previousAudio: {
          audioSource: 'mediasoup,studio',
          audioPlayer: 'mediasoup,studio',
          audioSourcePresent: true,
          audioPlayerPresent: true,
        },
        expectedAudio: {
          audioSource: 'alsa,original-in',
          audioPlayer: 'alsa,original-out',
          audioSourcePresent: true,
          audioPlayerPresent: true,
        },
      })}\n`,
      'utf8',
    );

    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'alsa,original-in',
      audioPlayer: 'alsa,original-out',
    });
    await manager.removeAccount(ACCOUNT_URI);
    expect(manager.getAccount(ACCOUNT_URI)).toBeUndefined();

    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).resolves.toBe(true);

    expect(manager.getAccount(ACCOUNT_URI)).toEqual(mapping);
    expect(await readFile(accountsPath, 'utf8')).toBe(originalAccounts);
    await expect(access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a legacy user journal mapping that omits endpointKind', async () => {
    const { configPath, accountsPath, journalPath } = await makePaths();
    const mapping = makeMapping({
      previousAudioSource: 'alsa,original-in',
      previousAudioPlayer: 'alsa,original-out',
    });
    const { endpointKind: _endpointKind, ...legacyMapping } = mapping;
    const originalAccounts = [
      '"Studio"<sip:studio@example.com>;audio_source=mediasoup,studio;audio_player=mediasoup,studio',
      '',
    ].join('\r\n');
    await writeFile(accountsPath, originalAccounts, 'utf8');
    const manager = new TalktomeBridgeConfigManager(configPath);
    await manager.load();
    await manager.setAccount(ACCOUNT_URI, mapping);
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        operation: 'delete',
        accountUri: ACCOUNT_URI,
        previousMapping: legacyMapping,
        expectedMapping: null,
        previousAudio: {
          audioSource: 'mediasoup,studio',
          audioPlayer: 'mediasoup,studio',
          audioSourcePresent: true,
          audioPlayerPresent: true,
        },
        expectedAudio: {
          audioSource: 'alsa,original-in',
          audioPlayer: 'alsa,original-out',
          audioSourcePresent: true,
          audioPlayerPresent: true,
        },
      })}\n`,
      'utf8',
    );

    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'alsa,original-in',
      audioPlayer: 'alsa,original-out',
    });
    await manager.removeAccount(ACCOUNT_URI);

    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).resolves.toBe(true);

    expect(manager.getAccount(ACCOUNT_URI)).toEqual(mapping);
    expect(await readFile(accountsPath, 'utf8')).toBe(originalAccounts);
    await expect(access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains divergent operator audio and the journal without changing either persisted file', async () => {
    const { configPath, accountsPath, journalPath } = await makePaths();
    await writeFile(
      accountsPath,
      '"Studio"<sip:studio@example.com>;audio_source=alsa,original-in;audio_player=alsa,original-out;vendor=keep\n',
      'utf8',
    );
    const manager = new TalktomeBridgeConfigManager(configPath);
    await manager.load();
    const expectedMapping = makeMapping({
      previousAudioSource: 'alsa,original-in',
      previousAudioPlayer: 'alsa,original-out',
    });
    const journalContents = `${JSON.stringify({
      version: 1,
      operation: 'put',
      accountUri: ACCOUNT_URI,
      previousMapping: null,
      expectedMapping,
      previousAudio: {
        audioSource: 'alsa,original-in',
        audioPlayer: 'alsa,original-out',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
      expectedAudio: {
        audioSource: 'mediasoup,studio',
        audioPlayer: 'mediasoup,studio',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
    })}\n`;
    await writeFile(journalPath, journalContents, 'utf8');
    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'mediasoup,studio',
      audioPlayer: 'mediasoup,studio',
    });
    await manager.setAccount(ACCOUNT_URI, expectedMapping);

    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'alsa,operator-in',
      audioPlayer: 'alsa,operator-out',
    });
    const operatorAccounts = await readFile(accountsPath, 'utf8');
    const currentConfig = await readFile(configPath, 'utf8');

    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).rejects.toThrow('divergent audio settings');

    expect(await readFile(accountsPath, 'utf8')).toBe(operatorAccounts);
    expect(await readFile(configPath, 'utf8')).toBe(currentConfig);
    expect(await readFile(journalPath, 'utf8')).toBe(journalContents);
  });

  it('retains a divergent operator mapping and journal without partially rolling back audio', async () => {
    const { configPath, accountsPath, journalPath } = await makePaths();
    await writeFile(
      accountsPath,
      '"Studio"<sip:studio@example.com>;audio_source=alsa,original-in;audio_player=alsa,original-out\n',
      'utf8',
    );
    const manager = new TalktomeBridgeConfigManager(configPath);
    await manager.load();
    const expectedMapping = makeMapping({
      previousAudioSource: 'alsa,original-in',
      previousAudioPlayer: 'alsa,original-out',
    });
    const journalContents = `${JSON.stringify({
      version: 1,
      operation: 'put',
      accountUri: ACCOUNT_URI,
      previousMapping: null,
      expectedMapping,
      previousAudio: {
        audioSource: 'alsa,original-in',
        audioPlayer: 'alsa,original-out',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
      expectedAudio: {
        audioSource: 'mediasoup,studio',
        audioPlayer: 'mediasoup,studio',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
    })}\n`;
    await writeFile(journalPath, journalContents, 'utf8');
    await updateAccountAudioDevicesAtomic(accountsPath, ACCOUNT_URI, {
      audioSource: 'mediasoup,studio',
      audioPlayer: 'mediasoup,studio',
    });
    await manager.setAccount(ACCOUNT_URI, expectedMapping);

    const operatorMapping = makeMapping({
      key: 'operator-selection',
      talktomeUserId: 99,
      target: { type: 'user', id: 99 },
      previousAudioSource: 'alsa,operator-in',
      previousAudioPlayer: 'alsa,operator-out',
    });
    await manager.setAccount(ACCOUNT_URI, operatorMapping);
    const expectedPostAccounts = await readFile(accountsPath, 'utf8');
    const operatorConfig = await readFile(configPath, 'utf8');

    await expect(
      recoverTalktomeMappingJournal(manager, accountsPath),
    ).rejects.toThrow(`mapping ${ACCOUNT_URI} has diverged`);

    expect(await readFile(accountsPath, 'utf8')).toBe(expectedPostAccounts);
    expect(await readFile(configPath, 'utf8')).toBe(operatorConfig);
    expect(manager.getAccount(ACCOUNT_URI)).toEqual(operatorMapping);
    expect(await readFile(journalPath, 'utf8')).toBe(journalContents);
  });
});
