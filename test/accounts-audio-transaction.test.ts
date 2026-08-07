import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseAccountsFile,
  updateAccountAudioDevicesAtomic,
  withAccountAudioTransaction,
} from '~/server/services/accounts-file';

const temporaryDirectories: string[] = [];

async function temporaryAccountsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'account-audio-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'accounts');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('lossless account audio transactions', () => {
  it('edits only audio values while preserving disabled lines, comments, unknown params, CRLF, and formatting', async () => {
    const accountsPath = await temporaryAccountsPath();
    const original = [
      '# generated account file - preserve this comment',
      '  #  "Studio"<SIP:Studio@Example.COM>;transport=tcp;audio_source=alsa,old-in;vendor_magic=keep me;audio_player=alsa,old-out;empty=  ',
      '"Other"<sip:other@example.com>;audio_source=alsa,other;audio_player=alsa,other-out',
      '',
    ].join('\r\n');
    const expected = original
      .replace('audio_source=alsa,old-in', 'audio_source=mediasoup,studio')
      .replace('audio_player=alsa,old-out', 'audio_player=mediasoup,studio');
    await writeFile(accountsPath, original, { encoding: 'utf8', mode: 0o640 });

    const result = await updateAccountAudioDevicesAtomic(
      accountsPath,
      'studio@example.com',
      {
        audioSource: 'mediasoup,studio',
        audioPlayer: 'mediasoup,studio',
      },
    );

    expect(result).toEqual({
      found: true,
      changed: true,
      before: {
        accountUri: 'sip:studio@example.com',
        audioSource: 'alsa,old-in',
        audioPlayer: 'alsa,old-out',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
      after: {
        accountUri: 'sip:studio@example.com',
        audioSource: 'mediasoup,studio',
        audioPlayer: 'mediasoup,studio',
        audioSourcePresent: true,
        audioPlayerPresent: true,
      },
    });
    expect(await readFile(accountsPath, 'utf8')).toBe(expected);
    expect((await stat(accountsPath)).mode & 0o777).toBe(0o640);
  });

  it('tracks parameter absence and restores the exact original bytes after rollback', async () => {
    const accountsPath = await temporaryAccountsPath();
    const original = [
      '; preamble with no final normalization',
      '"Studio"<sip:studio@example.com>;transport=udp;unknown=untouched   ',
      '# trailing comment',
    ].join('\r\n');
    await writeFile(accountsPath, original, 'utf8');

    await expect(
      withAccountAudioTransaction(accountsPath, async (transaction) => {
        expect(transaction.getAccountAudioDevices('studio@example.com')).toEqual({
          accountUri: 'sip:studio@example.com',
          audioSource: '',
          audioPlayer: '',
          audioSourcePresent: false,
          audioPlayerPresent: false,
        });
        const edit = transaction.setAccountAudioDevices('studio@example.com', {
          audioSource: 'mediasoup,studio',
          audioPlayer: 'mediasoup,studio',
        });
        expect(edit.after).toMatchObject({
          audioSourcePresent: true,
          audioPlayerPresent: true,
        });
        await expect(transaction.commit()).resolves.toBe(true);
        expect(await readFile(accountsPath, 'utf8')).not.toBe(original);
        throw new Error('simulated later config failure');
      }),
    ).rejects.toThrow('simulated later config failure');

    expect(await readFile(accountsPath, 'utf8')).toBe(original);
  });

  it('removes absent/empty audio parameters without rewriting unrelated bytes', async () => {
    const accountsPath = await temporaryAccountsPath();
    const original =
      '"Studio"<sip:studio@example.com>;audio_source=;unknown=x;audio_player=;transport=udp\n';
    await writeFile(accountsPath, original, 'utf8');

    await updateAccountAudioDevicesAtomic(accountsPath, 'studio@example.com', {
      audioSource: null,
      audioPlayer: null,
    });

    expect(await readFile(accountsPath, 'utf8')).toBe(
      '"Studio"<sip:studio@example.com>;unknown=x;transport=udp\n',
    );
  });

  it.each([
    {
      label: 'A: bare angle URI without display name',
      line: '<sip:2061536@sip.srgssr.ch>;auth_user=2061536;auth_pass=secret;audio_source=alsa,in',
    },
    {
      label: 'B: bare angle URI with transport inside <>',
      line: '<sip:2061536@sip.srgssr.ch;transport=tls>;auth_user=2061536;auth_pass=secret;audio_source=alsa,in',
    },
    {
      label: 'C: quoted display name without URI params',
      line: '"2061536"<sip:2061536@sip.srgssr.ch>;auth_user=2061536;auth_pass=secret;audio_source=alsa,in',
    },
    {
      label: 'D: quoted display name with transport inside <>',
      line: '"2061536"<sip:2061536@sip.srgssr.ch;transport=tls>;auth_user=2061536;auth_pass=secret;audio_source=alsa,in',
    },
  ])(
    'finds uastat bare AOR against accounts-file format $label',
    async ({ line }) => {
      const accountsPath = await temporaryAccountsPath();
      await writeFile(accountsPath, `${line}\n`, 'utf8');
      const selected = 'sip:2061536@sip.srgssr.ch';

      const result = await updateAccountAudioDevicesAtomic(accountsPath, selected, {
        audioSource: 'mediasoup,13',
        audioPlayer: 'mediasoup,13',
      });

      expect(result.found).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.before?.accountUri).toBe(selected);
      expect(result.after).toMatchObject({
        accountUri: selected,
        audioSource: 'mediasoup,13',
        audioPlayer: 'mediasoup,13',
      });
      const written = await readFile(accountsPath, 'utf8');
      expect(written).toContain('audio_source=mediasoup,13');
      expect(written).toContain('audio_player=mediasoup,13');
      expect(written).toContain('auth_pass=secret');
    },
  );
});

describe('parseAccountsFile', () => {
  it('parses optional display names and URI-local transport into bare AOR entries', async () => {
    const accountsPath = await temporaryAccountsPath();
    await writeFile(
      accountsPath,
      [
        '<sip:2061536@sip.srgssr.ch>;auth_pass=one;audio_source=alsa,a',
        '<sip:2061537@sip.srgssr.ch;transport=tls>;auth_pass=two',
        '"Named"<sip:2061538@sip.srgssr.ch;transport=tcp>;auth_pass=three;audio_player=alsa,b',
        '#"Off"<sip:2061539@sip.srgssr.ch>;auth_pass=four',
      ].join('\n'),
      'utf8',
    );

    await expect(parseAccountsFile(accountsPath)).resolves.toEqual([
      {
        name: '2061536',
        uri: 'sip:2061536@sip.srgssr.ch',
        enabled: true,
        transport: 'udp',
        auth_pass: 'one',
        answermode: 'auto',
        regint: 360,
        audio_source: 'alsa,a',
        audio_player: '',
        pubint: 0,
        inreq_allowed: true,
      },
      {
        name: '2061537',
        uri: 'sip:2061537@sip.srgssr.ch',
        enabled: true,
        transport: 'tls',
        auth_pass: 'two',
        answermode: 'auto',
        regint: 360,
        audio_source: '',
        audio_player: '',
        pubint: 0,
        inreq_allowed: true,
      },
      {
        name: 'Named',
        uri: 'sip:2061538@sip.srgssr.ch',
        enabled: true,
        transport: 'tcp',
        auth_pass: 'three',
        answermode: 'auto',
        regint: 360,
        audio_source: '',
        audio_player: 'alsa,b',
        pubint: 0,
        inreq_allowed: true,
      },
      {
        name: 'Off',
        uri: 'sip:2061539@sip.srgssr.ch',
        enabled: false,
        transport: 'udp',
        auth_pass: 'four',
        answermode: 'auto',
        regint: 360,
        audio_source: '',
        audio_player: '',
        pubint: 0,
        inreq_allowed: true,
      },
    ]);
  });
});
