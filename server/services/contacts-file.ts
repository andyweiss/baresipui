import fs from 'fs/promises';
import path from 'path';
import type { ContactFileEntry } from '~/types';

const HEADER = `#
# SIP contacts
#
# Displayname <sip:user@domain>;addr-params
#
#  addr-params:
#    ;presence={none,p2p}
#    ;access={allow,block}
#

`;

export async function parseContactsFile(filePath: string): Promise<ContactFileEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const entries: ContactFileEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Format: "Name" <sip:user@domain>;presence=p2p;access=allow
    const nameMatch = trimmed.match(/^"([^"]+)"\s+<(sip:[^>]+)>(.*)/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const uri = nameMatch[2];
    const params = nameMatch[3];

    const presenceMatch = params.match(/presence=(\w+)/);
    const accessMatch = params.match(/access=(\w+)/);

    entries.push({
      name,
      uri,
      presence: (presenceMatch?.[1] as 'none' | 'p2p') || 'p2p',
      access: accessMatch ? (accessMatch[1] as 'allow' | 'block') : undefined
    });
  }
  return entries;
}

export function formatContactLine(entry: ContactFileEntry): string {
  let line = `"${entry.name}" <${entry.uri}>;presence=${entry.presence}`;
  if (entry.access) line += `;access=${entry.access}`;
  return line;
}

export async function writeContactsFile(filePath: string, entries: ContactFileEntry[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const lines = entries.map(formatContactLine);

  await fs.writeFile(filePath, HEADER + lines.join('\n') + '\n', 'utf-8');
}
