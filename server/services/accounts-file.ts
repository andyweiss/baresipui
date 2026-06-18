import fs from 'fs/promises';
import path from 'path';
import type { AccountFileEntry } from '~/types';

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

    // Format: "Name"<sip:user@domain>;param=val;...
    const match = accountLine.match(/^"([^"]+)"<(sip:[^>]+)>(.*)/);
    if (!match) continue;

    const name = match[1];
    const uri = match[2];
    const paramStr = match[3];

    entries.push({
      name,
      uri,
      enabled,
      transport: (extractParam(paramStr, 'transport') as 'udp' | 'tcp' | 'tls') || 'udp',
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
  await fs.mkdir(dir, { recursive: true });
  const content = entries.map(serializeAccount).join('\n') + '\n';
  await fs.writeFile(filePath, content, 'utf-8');
}
