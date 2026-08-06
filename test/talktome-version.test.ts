import { describe, expect, it } from 'vitest';
import {
  compareTalktomeVersions,
  DEFAULT_TALKTOME_TESTED_VERSION,
  extractTalktomeAppVersion,
  isTalktomeServerNewerThanTested,
  normalizeTalktomeVersionLabel,
  parseTalktomeVersion,
  resolveComparableTalktomeVersion,
  resolveTalktomeTestedVersion,
} from '~/server/services/talktome/version';

describe('talktome version helpers', () => {
  it('defaults the tested version to the current verified release', () => {
    expect(DEFAULT_TALKTOME_TESTED_VERSION).toBe('1.1.3');
  });

  it('normalizes package and git-describe labels', () => {
    expect(normalizeTalktomeVersionLabel(' v1.1.3 ')).toBe('1.1.3');
    expect(normalizeTalktomeVersionLabel('unknown')).toBeUndefined();
    expect(parseTalktomeVersion('v1.1.3-5-gabcdef0')).toEqual({
      core: [1, 1, 3],
      commitsAfterTag: 5,
      raw: '1.1.3-5-gabcdef0',
    });
  });

  it('compares core versions and git commits-after-tag', () => {
    expect(compareTalktomeVersions('1.1.3', 'v1.1.3')).toBe(0);
    expect(compareTalktomeVersions('1.1.4', '1.1.3')).toBeGreaterThan(0);
    expect(compareTalktomeVersions('1.1.2', '1.1.3')).toBeLessThan(0);
    expect(compareTalktomeVersions('1.1.3-2-gabc', '1.1.3')).toBeGreaterThan(0);
    expect(compareTalktomeVersions('not-a-version', '1.1.3')).toBeNull();
  });

  it('flags only strictly newer server versions', () => {
    expect(isTalktomeServerNewerThanTested('1.1.3', '1.1.3')).toBe(false);
    expect(isTalktomeServerNewerThanTested('1.1.2', '1.1.3')).toBe(false);
    expect(isTalktomeServerNewerThanTested('1.1.4', '1.1.3')).toBe(true);
    expect(isTalktomeServerNewerThanTested('v1.2.0', '1.1.3')).toBe(true);
  });

  it('extracts appVersion-like fields from opaque JSON payloads', () => {
    expect(extractTalktomeAppVersion({ ok: true, appVersion: 'v1.1.4' })).toBe(
      '1.1.4',
    );
    expect(
      extractTalktomeAppVersion({ serverVersion: '1.1.3', version: 'ignored' }),
    ).toBe('1.1.3');
    expect(extractTalktomeAppVersion({ ok: true })).toBeUndefined();
    expect(extractTalktomeAppVersion({ appVersion: 'dev' })).toBeUndefined();
  });

  it('rejects non-comparable labels for tested/server overrides', () => {
    expect(resolveComparableTalktomeVersion('dev')).toBeUndefined();
    expect(resolveComparableTalktomeVersion('v1.1.3')).toBe('1.1.3');

    const invalid: string[] = [];
    expect(
      resolveTalktomeTestedVersion('dev', (value, fallback) => {
        invalid.push(`${value}->${fallback}`);
      }),
    ).toBe('1.1.3');
    expect(invalid).toEqual(['dev->1.1.3']);
    expect(resolveTalktomeTestedVersion('1.2.0')).toBe('1.2.0');
    expect(resolveTalktomeTestedVersion(undefined)).toBe('1.1.3');
  });
});
