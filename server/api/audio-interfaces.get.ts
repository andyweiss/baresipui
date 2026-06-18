import fs from 'fs/promises';

// Parses pcm.<name> { ... } entries from .asoundrc
// Returns separate lists for inputs (in*) and outputs (out*)
// Skips internal shared devices (dmix/dsnoop)
export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  const filePath = config.asoundrcPath as string;

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { inputs: [], outputs: [], all: [] };
  }

  const inputs: string[] = [];
  const outputs: string[] = [];

  const typeMap: Record<string, string> = {};
  let currentName: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    const pcmMatch = trimmed.match(/^pcm\.(\S+)\s*\{/);
    if (pcmMatch) {
      currentName = pcmMatch[1];
      continue;
    }

    const typeMatch = trimmed.match(/^type\s+(\S+)/);
    if (typeMatch && currentName) {
      typeMap[currentName] = typeMatch[1];
      currentName = null;
    }
  }

  for (const [name, type] of Object.entries(typeMap)) {
    // Only expose route devices (not dmix/dsnoop shared buses)
    if (type !== 'route') continue;
    if (name.startsWith('in')) inputs.push(name);
    else if (name.startsWith('out')) outputs.push(name);
  }

  // Sort numerically (in_ch1 < in_ch2 < ... < in_ch10)
  const numSort = (a: string, b: string) => {
    const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
    return na - nb || a.localeCompare(b);
  };

  inputs.sort(numSort);
  outputs.sort(numSort);

  return { inputs, outputs };
});
