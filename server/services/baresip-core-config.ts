import fs from 'node:fs/promises';
import path from 'node:path';
import { lineSpans, writeRawAtomic } from './accounts-file';
import {
  BARESIP_CONFIG_KEYS,
  validateBaresipConfigValue,
  type BaresipConfigEntries,
  type BaresipConfigKey,
} from '~/types';

const coreConfigFileOperations = new Map<string, Promise<void>>();

export type BaresipConfigErrorCode =
  | 'invalid-value'
  | 'missing-file'
  | 'missing-key'
  | 'conflict'
  | 'rollback-failed';

export class BaresipConfigError extends Error {
  constructor(readonly code: BaresipConfigErrorCode, message: string) {
    super(message);
    this.name = 'BaresipConfigError';
  }
}

export function validateConfigValue(key: BaresipConfigKey, value: string): void {
  const problem = validateBaresipConfigValue(key, value);
  if (problem) {
    throw new BaresipConfigError('invalid-value', `${key}: ${problem}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ParsedConfigLine {
  key: BaresipConfigKey;
  lineStart: number;
  lineEnd: number;
  enabled: boolean;
  commentMarkerStart: number | undefined;
  commentMarkerEnd: number | undefined;
  valueStart: number;
  valueEnd: number;
  value: string;
}

function parseConfigLine(
  key: BaresipConfigKey,
  line: string,
  lineStart: number,
): ParsedConfigLine | undefined {
  const newline = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
  const body = newline ? line.slice(0, -newline.length) : line;
  const pattern = new RegExp(
    `^(\\s*)(#\\s*)?(${escapeRegExp(key)})([ \\t]+)(\\S[^#\\r\\n]*?)([ \\t]*)(#[^\\r\\n]*)?$`,
    'd',
  );
  const match = pattern.exec(body) as (RegExpExecArray & { indices: Array<[number, number] | undefined> }) | null;
  if (!match) return undefined;

  const commentGroupIndices = match.indices[2];
  const valueIndices = match.indices[5];
  if (!valueIndices) return undefined;

  return {
    key,
    lineStart,
    lineEnd: lineStart + line.length,
    enabled: !commentGroupIndices,
    commentMarkerStart: commentGroupIndices ? lineStart + commentGroupIndices[0] : undefined,
    commentMarkerEnd: commentGroupIndices ? lineStart + commentGroupIndices[1] : undefined,
    valueStart: lineStart + valueIndices[0],
    valueEnd: lineStart + valueIndices[1],
    value: match[5],
  };
}

/**
 * Locates the line that actually governs a key. baresip never sees commented
 * lines, so an active line always wins over a commented one above it; a
 * commented line is only used when the key has no active line at all.
 */
function findConfigLine(content: string, key: BaresipConfigKey): ParsedConfigLine | undefined {
  let commented: ParsedConfigLine | undefined;
  for (const span of lineSpans(content)) {
    const parsed = parseConfigLine(key, span.line, span.start);
    if (!parsed) continue;
    if (parsed.enabled) return parsed;
    commented ??= parsed;
  }
  return commented;
}

function entriesFromContent(content: string): BaresipConfigEntries {
  const entries = {} as BaresipConfigEntries;
  for (const key of BARESIP_CONFIG_KEYS) {
    const parsed = findConfigLine(content, key);
    entries[key] = parsed
      ? { value: parsed.value, enabled: parsed.enabled, present: true }
      : { value: null, enabled: false, present: false };
  }
  return entries;
}

export interface BaresipCoreConfigState {
  /** false = the config file itself does not exist at the configured path. */
  exists: boolean;
  entries: BaresipConfigEntries;
}

/**
 * Reads the curated keys straight from the config file. Nothing is filled in
 * from defaults: a key the file does not contain is reported as absent so the
 * UI can never show a value that is not actually on disk.
 */
export async function readBaresipCoreConfigState(
  filePath: string,
): Promise<BaresipCoreConfigState> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { exists: false, entries: entriesFromContent('') };
    }
    throw err;
  }
  return { exists: true, entries: entriesFromContent(content) };
}

/**
 * Serializes config-file transactions per path and keeps the original bytes
 * available for an exact rollback if a later write fails.
 */
export async function withBaresipCoreConfigTransaction<T>(
  filePath: string,
  operation: (transaction: BaresipCoreConfigTransaction) => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = coreConfigFileOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn, () => turn);
  coreConfigFileOperations.set(key, queued);
  await previous.catch(() => undefined);

  let transaction: BaresipCoreConfigTransaction | undefined;
  try {
    transaction = await BaresipCoreConfigTransaction.open(key);
    return await operation(transaction);
  } catch (error) {
    await transaction?.rollback().catch((rollbackError) => {
      const combined = new BaresipConfigError(
        'rollback-failed',
        'Config file update and lossless rollback both failed',
      ) as BaresipConfigError & { errors: unknown[] };
      combined.errors = [error, rollbackError];
      throw combined;
    });
    throw error;
  } finally {
    release();
    if (coreConfigFileOperations.get(key) === queued) {
      coreConfigFileOperations.delete(key);
    }
  }
}

/** Resolves to true when the file was actually rewritten, false when it already matched. */
export function updateBaresipCoreConfigAtomic(
  filePath: string,
  updates: Partial<Record<BaresipConfigKey, string>>,
): Promise<boolean> {
  return withBaresipCoreConfigTransaction(filePath, async (transaction) => {
    for (const [key, value] of Object.entries(updates) as [BaresipConfigKey, string][]) {
      transaction.setValue(key, value);
    }
    return transaction.commit();
  });
}

export class BaresipCoreConfigTransaction {
  private workingContent: string;
  private committedContent: string | undefined;

  private constructor(
    readonly filePath: string,
    private readonly originalContent: string,
    private readonly fileMode: number,
  ) {
    this.workingContent = originalContent;
  }

  static async open(filePath: string): Promise<BaresipCoreConfigTransaction> {
    try {
      const [content, fileStat] = await Promise.all([
        fs.readFile(filePath, 'utf8'),
        fs.stat(filePath),
      ]);
      return new BaresipCoreConfigTransaction(filePath, content, fileStat.mode & 0o777);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new BaresipConfigError('missing-file', `Config file ${filePath} does not exist`);
      }
      throw err;
    }
  }

  setValue(key: BaresipConfigKey, value: string): void {
    validateConfigValue(key, value);
    const target = findConfigLine(this.workingContent, key);
    if (!target) {
      throw new BaresipConfigError(
        'missing-key',
        `${key} has no line in the config file — add it to the file first`,
      );
    }

    let line = this.workingContent.slice(target.lineStart, target.lineEnd);
    const localValueStart = target.valueStart - target.lineStart;
    const localValueEnd = target.valueEnd - target.lineStart;
    line = line.slice(0, localValueStart) + value + line.slice(localValueEnd);

    if (!target.enabled && target.commentMarkerStart !== undefined) {
      const localCommentStart = target.commentMarkerStart - target.lineStart;
      const localCommentEnd = target.commentMarkerEnd! - target.lineStart;
      line = line.slice(0, localCommentStart) + line.slice(localCommentEnd);
    }

    this.workingContent =
      this.workingContent.slice(0, target.lineStart) +
      line +
      this.workingContent.slice(target.lineEnd);
  }

  hasChanges(): boolean {
    return this.workingContent !== this.originalContent;
  }

  async commit(): Promise<boolean> {
    if (!this.hasChanges()) return false;
    if (this.committedContent !== undefined) {
      throw new Error('Config transaction was already committed');
    }
    const current = await fs.readFile(this.filePath, 'utf8');
    if (current !== this.originalContent) {
      throw new BaresipConfigError(
        'conflict',
        'Config file changed since it was loaded; refusing to overwrite it',
      );
    }
    await writeRawAtomic(this.filePath, this.workingContent, this.fileMode, () => {
      this.committedContent = this.workingContent;
    });
    return true;
  }

  async rollback(): Promise<void> {
    if (this.committedContent === undefined) return;
    const current = await fs.readFile(this.filePath, 'utf8');
    if (current !== this.committedContent) {
      throw new Error(
        'Config file changed outside the transaction; refusing destructive rollback',
      );
    }
    await writeRawAtomic(this.filePath, this.originalContent, this.fileMode);
    this.committedContent = undefined;
  }
}
