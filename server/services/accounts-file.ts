import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountFileEntry } from '~/types';
import { normalizeAccountUri } from './talktome-bridge-config';

export interface AccountAudioDevices {
  accountUri: string;
  audioSource: string;
  audioPlayer: string;
  audioSourcePresent: boolean;
  audioPlayerPresent: boolean;
}

export interface AccountAudioDeviceUpdate {
  /** null removes the parameter; a string sets or adds it. */
  audioSource: string | null;
  /** null removes the parameter; a string sets or adds it. */
  audioPlayer: string | null;
}

export interface AccountAudioEditResult {
  found: boolean;
  changed: boolean;
  before?: AccountAudioDevices;
  after?: AccountAudioDevices;
}

const accountFileOperations = new Map<string, Promise<void>>();

export async function parseAccountsFile(filePath: string): Promise<AccountFileEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const entries: AccountFileEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const enabled = !trimmed.startsWith('#');
    const accountLine = enabled ? trimmed : trimmed.slice(1).trim();

    // baresip accepts optional display name and URI params inside <...>:
    //   <sip:user@host>;auth_pass=...
    //   <sip:user@host;transport=tls>;auth_pass=...
    //   "Name"<sip:user@host>;...
    //   "Name"<sip:user@host;transport=tls>;...
    const match = accountLine.match(/^(?:"([^"]*)"\s*)?<([^>]+)>(.*)$/);
    if (!match) continue;

    let uri: string;
    try {
      uri = accountAor(match[2]);
    } catch {
      continue;
    }

    const paramStr = match[3];
    const uriParamStr = uriParameters(match[2]);
    const name = match[1]?.trim() || uri.replace(/^sip:/i, '').split('@')[0] || uri;
    const transport =
      (extractParam(paramStr, 'transport') as 'udp' | 'tcp' | 'tls' | undefined) ||
      (extractParam(uriParamStr, 'transport') as 'udp' | 'tcp' | 'tls' | undefined) ||
      'udp';

    entries.push({
      name,
      uri,
      enabled,
      transport,
      auth_pass: extractParam(paramStr, 'auth_pass') || '',
      answermode: (extractParam(paramStr, 'answermode') as 'manual' | 'early' | 'auto') || 'auto',
      regint: parseInt(extractParam(paramStr, 'regint') || '360', 10),
      audio_source: extractParam(paramStr, 'audio_source') || '',
      audio_player: extractParam(paramStr, 'audio_player') || '',
      pubint: parseInt(extractParam(paramStr, 'pubint') || '0', 10),
      inreq_allowed: extractParam(paramStr, 'inreq_allowed') !== 'no'
    });
  }
  return entries;
}

function extractParam(paramStr: string, key: string): string | undefined {
  const match = paramStr.match(new RegExp(`(?:^|;)${key}=([^;]+)`));
  return match?.[1];
}

function serializeAccount(entry: AccountFileEntry): string {
  const params = [
    `transport=${entry.transport}`,
    `auth_pass=${entry.auth_pass}`,
    `answermode=${entry.answermode}`,
    `regint=${entry.regint}`,
    `audio_source=${entry.audio_source}`,
    `audio_player=${entry.audio_player}`,
    `pubint=${entry.pubint}`,
    `inreq_allowed=${entry.inreq_allowed ? 'yes' : 'no'}`
  ].join(';');

  const line = `"${entry.name}"<${entry.uri}>;${params}`;
  return entry.enabled ? line : `#${line}`;
}

export async function writeAccountsFile(filePath: string, entries: AccountFileEntry[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const content = entries.map(serializeAccount).join('\n') + '\n';
  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${
      Math.random().toString(16).slice(2)
    }.tmp`,
  );

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Serializes a bridge account-file transaction and keeps the original bytes
 * available for an exact rollback if a later config write fails. Only the two
 * audio parameters on explicitly selected account lines can be changed.
 */
export async function withAccountAudioTransaction<T>(
  filePath: string,
  operation: (transaction: AccountAudioTransaction) => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = accountFileOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn, () => turn);
  accountFileOperations.set(key, queued);
  await previous.catch(() => undefined);

  let transaction: AccountAudioTransaction | undefined;
  try {
    transaction = await AccountAudioTransaction.open(key);
    return await operation(transaction);
  } catch (error) {
    await transaction?.rollback().catch((rollbackError) => {
      const combined = new Error(
        'Account audio transaction and lossless rollback both failed',
      ) as Error & { errors: unknown[] };
      combined.errors = [error, rollbackError];
      throw combined;
    });
    throw error;
  } finally {
    release();
    if (accountFileOperations.get(key) === queued) {
      accountFileOperations.delete(key);
    }
  }
}

export function updateAccountAudioDevicesAtomic(
  filePath: string,
  accountUri: string,
  update: AccountAudioDeviceUpdate,
): Promise<AccountAudioEditResult> {
  return withAccountAudioTransaction(filePath, async (transaction) => {
    const result = transaction.setAccountAudioDevices(accountUri, update);
    await transaction.commit();
    return result;
  });
}

export class AccountAudioTransaction {
  private workingContent: string;
  private committedContent: string | undefined;

  private constructor(
    readonly filePath: string,
    private readonly originalContent: string | undefined,
    private readonly fileMode: number,
  ) {
    this.workingContent = originalContent ?? '';
  }

  static async open(filePath: string): Promise<AccountAudioTransaction> {
    try {
      const [content, fileStat] = await Promise.all([
        fs.readFile(filePath, 'utf8'),
        fs.stat(filePath),
      ]);
      return new AccountAudioTransaction(filePath, content, fileStat.mode & 0o777);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return new AccountAudioTransaction(filePath, undefined, 0o600);
      }
      throw error;
    }
  }

  getAccountAudioDevices(accountUri: string): AccountAudioDevices | undefined {
    const match = this.findTargetLine(accountUri);
    if (!match) return undefined;
    const audioSource = parameterValue(match.parameters, 'audio_source');
    const audioPlayer = parameterValue(match.parameters, 'audio_player');
    return {
      accountUri: match.accountUri,
      audioSource: audioSource ?? '',
      audioPlayer: audioPlayer ?? '',
      audioSourcePresent: audioSource !== undefined,
      audioPlayerPresent: audioPlayer !== undefined,
    };
  }

  setAccountAudioDevices(
    accountUri: string,
    update: AccountAudioDeviceUpdate,
  ): AccountAudioEditResult {
    validateAudioParameter(update.audioSource, 'audioSource');
    validateAudioParameter(update.audioPlayer, 'audioPlayer');
    const target = this.findTargetLine(accountUri);
    if (!target) return { found: false, changed: false };

    const before: AccountAudioDevices = {
      accountUri: target.accountUri,
      audioSource: parameterValue(target.parameters, 'audio_source') ?? '',
      audioPlayer: parameterValue(target.parameters, 'audio_player') ?? '',
      audioSourcePresent:
        parameterValue(target.parameters, 'audio_source') !== undefined,
      audioPlayerPresent:
        parameterValue(target.parameters, 'audio_player') !== undefined,
    };
    let parameters = replaceParameter(
      target.parameters,
      'audio_source',
      update.audioSource,
    );
    parameters = replaceParameter(
      parameters,
      'audio_player',
      update.audioPlayer,
    );
    const replacement =
      target.line.slice(0, target.parametersStart) +
      parameters +
      target.line.slice(target.parametersEnd);
    const changed = replacement !== target.line;
    if (changed) {
      this.workingContent =
        this.workingContent.slice(0, target.lineStart) +
        replacement +
        this.workingContent.slice(target.lineEnd);
    }
    return {
      found: true,
      changed,
      before,
      after: {
        accountUri: target.accountUri,
        audioSource: parameterValue(parameters, 'audio_source') ?? '',
        audioPlayer: parameterValue(parameters, 'audio_player') ?? '',
        audioSourcePresent:
          parameterValue(parameters, 'audio_source') !== undefined,
        audioPlayerPresent:
          parameterValue(parameters, 'audio_player') !== undefined,
      },
    };
  }

  hasChanges(): boolean {
    return (
      this.originalContent !== undefined &&
      this.workingContent !== this.originalContent
    );
  }

  async commit(): Promise<boolean> {
    if (!this.hasChanges()) return false;
    if (this.committedContent !== undefined) {
      throw new Error('Account audio transaction was already committed');
    }
    const current = await fs.readFile(this.filePath, 'utf8');
    if (current !== this.originalContent) {
      throw new Error(
        'Accounts file changed outside the bridge transaction; refusing to overwrite it',
      );
    }
    await writeRawAtomic(
      this.filePath,
      this.workingContent,
      this.fileMode,
      () => {
        // Rename is the commit point. Record it before chmod/directory fsync so
        // failures after replacement still trigger an exact byte rollback.
        this.committedContent = this.workingContent;
      },
    );
    return true;
  }

  async rollback(): Promise<void> {
    if (
      this.committedContent === undefined ||
      this.originalContent === undefined
    ) {
      return;
    }
    const current = await fs.readFile(this.filePath, 'utf8');
    if (current !== this.committedContent) {
      throw new Error(
        'Accounts file changed outside the bridge transaction; refusing destructive rollback',
      );
    }
    await writeRawAtomic(this.filePath, this.originalContent, this.fileMode);
    this.committedContent = undefined;
  }

  private findTargetLine(accountUri: string): ParsedAccountLine | undefined {
    // uastat / UI supply a bare AOR; match on that regardless of URI params
    // inside the accounts-file <...> (e.g. ;transport=tls).
    const normalized = accountAor(accountUri);
    const matches: ParsedAccountLine[] = [];
    for (const span of lineSpans(this.workingContent)) {
      const parsed = parseRawAccountLine(span.line, span.start, span.end);
      if (parsed?.accountUri === normalized) matches.push(parsed);
    }
    if (matches.length > 1) {
      throw new Error(`Accounts file contains duplicate account ${normalized}`);
    }
    return matches[0];
  }
}

interface ParsedAccountLine {
  accountUri: string;
  line: string;
  lineStart: number;
  lineEnd: number;
  parameters: string;
  parametersStart: number;
  parametersEnd: number;
}

function parseRawAccountLine(
  line: string,
  lineStart: number,
  lineEnd: number,
): ParsedAccountLine | undefined {
  const newline = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
  const body = newline ? line.slice(0, -newline.length) : line;
  // Display name is optional; baresip does not require it.
  const match = body.match(/^\s*(?:#\s*)?(?:"[^"]*"\s*)?<([^>]+)>(.*)$/);
  if (!match) return undefined;
  let accountUri: string;
  try {
    accountUri = accountAor(match[1]);
  } catch {
    return undefined;
  }
  const parameters = match[2];
  const parametersStart = body.length - parameters.length;
  return {
    accountUri,
    line,
    lineStart,
    lineEnd,
    parameters,
    parametersStart,
    parametersEnd: body.length,
  };
}

/** Bare sip:user@host AOR used for accounts-file lookup against uastat URIs. */
function accountAor(value: string): string {
  const normalized = normalizeAccountUri(value);
  const separator = normalized.indexOf(';');
  return separator === -1 ? normalized : normalized.slice(0, separator);
}

/** Parameter suffix from inside <sip:user@host;param=...>, as ;param=... */
function uriParameters(angleUri: string): string {
  const separator = angleUri.indexOf(';');
  return separator === -1 ? '' : angleUri.slice(separator);
}

function lineSpans(
  content: string,
): Array<{ line: string; start: number; end: number }> {
  const spans: Array<{ line: string; start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n' && content[index] !== '\r') continue;
    let end = index + 1;
    if (content[index] === '\r' && content[index + 1] === '\n') end += 1;
    spans.push({ line: content.slice(start, end), start, end });
    start = end;
    index = end - 1;
  }
  if (start < content.length) {
    spans.push({ line: content.slice(start), start, end: content.length });
  }
  return spans;
}

function parameterValue(parameters: string, key: string): string | undefined {
  const match = parameters.match(
    new RegExp(`(?:^|;)${escapeRegExp(key)}=([^;]*)`, 'i'),
  );
  return match?.[1];
}

function replaceParameter(
  parameters: string,
  key: string,
  value: string | null,
): string {
  let found = false;
  const expression = new RegExp(
    `(^|;)(${escapeRegExp(key)})=([^;]*)`,
    'gi',
  );
  const replaced = parameters.replace(
    expression,
    (_whole, separator: string, originalKey: string) => {
      found = true;
      return value === null ? '' : `${separator}${originalKey}=${value}`;
    },
  );
  if (found || value === null) return replaced;

  const trailingWhitespace = replaced.match(/[ \t]*$/)?.[0] ?? '';
  const insertionPoint = replaced.length - trailingWhitespace.length;
  return `${replaced.slice(0, insertionPoint)};${key}=${value}${trailingWhitespace}`;
}

function validateAudioParameter(value: string | null, label: string): void {
  if (value === null) return;
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    /[;\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} is invalid for an accounts-file parameter`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeRawAtomic(
  filePath: string,
  content: string,
  mode: number,
  onRenamed?: () => void,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${
      Math.random().toString(16).slice(2)
    }.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    onRenamed?.();
    await fs.chmod(filePath, mode);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
