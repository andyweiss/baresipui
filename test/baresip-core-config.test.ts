import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaresipConfigError,
  readBaresipCoreConfigState,
  updateBaresipCoreConfigAtomic,
  withBaresipCoreConfigTransaction,
} from '~/server/services/baresip-core-config';

const temporaryDirectories: string[] = [];

async function temporaryConfigPath(content?: string, mode = 0o644): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'baresip-core-config-test-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'config');
  if (content !== undefined) {
    await writeFile(filePath, content, { encoding: 'utf8', mode });
  }
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('reading the baresip core config', () => {
  it('reports on-disk state only, never a default, for active, commented and absent keys', async () => {
    const filePath = await temporaryConfigPath([
      '# Core config',
      'sip_trace               yes',
      '#call_max_calls         24',
      'audio_buffer            20-160          # tuned for the studio',
      '',
    ].join('\n'));

    const { exists, entries } = await readBaresipCoreConfigState(filePath);

    expect(exists).toBe(true);
    expect(entries.sip_trace).toEqual({ value: 'yes', enabled: true, present: true });
    expect(entries.call_max_calls).toEqual({ value: '24', enabled: false, present: true });
    expect(entries.audio_buffer).toEqual({ value: '20-160', enabled: true, present: true });
    // Absent keys stay absent — no value is invented for the form.
    expect(entries.opus_bitrate).toEqual({ value: null, enabled: false, present: false });
  });

  it('prefers the active line over a commented one for the same key', async () => {
    const filePath = await temporaryConfigPath([
      '#opus_bitrate           128000',
      'opus_bitrate            64000',
      '',
    ].join('\n'));

    const { entries } = await readBaresipCoreConfigState(filePath);
    expect(entries.opus_bitrate).toEqual({ value: '64000', enabled: true, present: true });
  });

  it('reports a missing file rather than falling back to defaults', async () => {
    const filePath = await temporaryConfigPath();

    const { exists, entries } = await readBaresipCoreConfigState(filePath);

    expect(exists).toBe(false);
    expect(entries.sip_trace).toEqual({ value: null, enabled: false, present: false });
  });
});

describe('writing the baresip core config', () => {
  it('rewrites only the values, preserving comments, spacing, CRLF and file mode', async () => {
    const filePath = await temporaryConfigPath([
      '# Core config - keep this header',
      'sip_trace               yes',
      'audio_buffer            20-160          # tuned for the studio',
      'opus_bitrate            128000',
      '',
    ].join('\r\n'), 0o640);
    const original = await readFile(filePath, 'utf8');

    const changed = await updateBaresipCoreConfigAtomic(filePath, {
      sip_trace: 'no',
      audio_buffer: '100-400',
    });

    expect(changed).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe(
      original
        .replace('sip_trace               yes', 'sip_trace               no')
        .replace('audio_buffer            20-160', 'audio_buffer            100-400'),
    );
    expect((await stat(filePath)).mode & 0o777).toBe(0o640);
  });

  it('activates a commented line when its value is saved', async () => {
    const filePath = await temporaryConfigPath([
      '#call_max_calls         24',
      '',
    ].join('\n'));

    await updateBaresipCoreConfigAtomic(filePath, { call_max_calls: '4' });

    expect(await readFile(filePath, 'utf8')).toBe('call_max_calls         4\n');
    const { entries } = await readBaresipCoreConfigState(filePath);
    expect(entries.call_max_calls).toEqual({ value: '4', enabled: true, present: true });
  });

  it('does not rewrite the file when the value already matches', async () => {
    const filePath = await temporaryConfigPath('sip_trace               yes\n');

    const changed = await updateBaresipCoreConfigAtomic(filePath, { sip_trace: 'yes' });

    expect(changed).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe('sip_trace               yes\n');
  });

  it('refuses to invent a line for a key the file does not contain', async () => {
    const filePath = await temporaryConfigPath('sip_trace               yes\n');

    await expect(
      updateBaresipCoreConfigAtomic(filePath, { opus_bitrate: '64000' }),
    ).rejects.toMatchObject({ code: 'missing-key' });
    expect(await readFile(filePath, 'utf8')).toBe('sip_trace               yes\n');
  });

  it('rejects invalid values without touching the file, including one bad key in a batch', async () => {
    const original = 'sip_trace               yes\ncall_max_calls          24\n';
    const filePath = await temporaryConfigPath(original);

    await expect(
      updateBaresipCoreConfigAtomic(filePath, { sip_trace: 'no', call_max_calls: 'lots' }),
    ).rejects.toBeInstanceOf(BaresipConfigError);
    expect(await readFile(filePath, 'utf8')).toBe(original);

    await expect(
      updateBaresipCoreConfigAtomic(filePath, { audio_buffer: 'nope # injected' }),
    ).rejects.toMatchObject({ code: 'invalid-value' });
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('refuses to overwrite a file that changed after it was loaded', async () => {
    const filePath = await temporaryConfigPath('sip_trace               yes\n');

    const conflicting = withBaresipCoreConfigTransaction(filePath, async (transaction) => {
      transaction.setValue('sip_trace', 'no');
      // An outside edit lands between load and commit.
      await writeFile(filePath, 'sip_trace               yes\n# edited elsewhere\n', 'utf8');
      return transaction.commit();
    });

    await expect(conflicting).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(filePath, 'utf8')).toBe(
      'sip_trace               yes\n# edited elsewhere\n',
    );
  });

  it('reports a missing config file instead of creating one', async () => {
    const filePath = await temporaryConfigPath();

    await expect(
      updateBaresipCoreConfigAtomic(filePath, { sip_trace: 'no' }),
    ).rejects.toMatchObject({ code: 'missing-file' });
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent writes so both land in the file', async () => {
    const filePath = await temporaryConfigPath(
      'sip_trace               yes\ncall_max_calls          24\n',
    );

    await Promise.all([
      updateBaresipCoreConfigAtomic(filePath, { sip_trace: 'no' }),
      updateBaresipCoreConfigAtomic(filePath, { call_max_calls: '4' }),
    ]);

    expect(await readFile(filePath, 'utf8')).toBe(
      'sip_trace               no\ncall_max_calls          4\n',
    );
  });
});
