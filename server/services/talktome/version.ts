/**
 * Helpers for comparing talktome server versions against the build/runtime
 * version this bridge was tested with.
 *
 * Accepts common labels from package.json (`1.1.3`), git describe
 * (`v1.1.3`, `v1.1.3-5-gabcdef0`, `v1.1.3-dirty`), and ignores unknown
 * suffixes that do not encode a newer release.
 */

export const DEFAULT_TALKTOME_TESTED_VERSION = '1.1.3';

export interface ParsedTalktomeVersion {
  /** major.minor.patch */
  core: [number, number, number];
  /**
   * Commits after the tag from `git describe` (`1.1.3-5-gabc` → 5).
   * Packaged releases use 0.
   */
  commitsAfterTag: number;
  raw: string;
}

const CORE_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?(?:[.+~].*)?$/i;

export function normalizeTalktomeVersionLabel(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;
  return trimmed.replace(/^v/i, '');
}

export function parseTalktomeVersion(
  value: string,
): ParsedTalktomeVersion | undefined {
  const normalized = normalizeTalktomeVersionLabel(value);
  if (!normalized) return undefined;
  const match = CORE_RE.exec(normalized);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    commitsAfterTag: match[4] ? Number(match[4]) : 0,
    raw: normalized,
  };
}

/**
 * @returns negative if `a` < `b`, positive if `a` > `b`, 0 if equal,
 * or `null` when either side cannot be parsed.
 */
export function compareTalktomeVersions(
  a: string,
  b: string,
): number | null {
  const left = parseTalktomeVersion(a);
  const right = parseTalktomeVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.commitsAfterTag !== right.commitsAfterTag) {
    return left.commitsAfterTag < right.commitsAfterTag ? -1 : 1;
  }
  return 0;
}

export function isTalktomeServerNewerThanTested(
  serverVersion: string,
  testedVersion: string,
): boolean {
  const comparison = compareTalktomeVersions(serverVersion, testedVersion);
  return comparison !== null && comparison > 0;
}

export function extractTalktomeAppVersion(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['appVersion', 'serverVersion', 'version'] as const) {
    const candidate = value[key];
    if (typeof candidate === 'string') {
      const resolved = resolveComparableTalktomeVersion(candidate);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/**
 * Accept only labels that `parseTalktomeVersion` understands so comparisons
 * cannot silently disable the newer-server warning.
 */
export function resolveComparableTalktomeVersion(
  value: string | undefined,
): string | undefined {
  const normalized = normalizeTalktomeVersionLabel(value || '');
  if (!normalized || !parseTalktomeVersion(normalized)) return undefined;
  return normalized;
}

export function resolveTalktomeTestedVersion(
  value: string | undefined,
  onInvalid?: (invalid: string, fallback: string) => void,
): string {
  const normalized = normalizeTalktomeVersionLabel(value || '');
  if (!normalized) return DEFAULT_TALKTOME_TESTED_VERSION;
  if (parseTalktomeVersion(normalized)) return normalized;
  onInvalid?.(normalized, DEFAULT_TALKTOME_TESTED_VERSION);
  return DEFAULT_TALKTOME_TESTED_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
