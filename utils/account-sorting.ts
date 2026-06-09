function extractSipNumber(uri: string): number | null {
  if (!uri) return null;
  const match = uri.replace(/^sip:/, '').match(/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1].replace(/^0+/, ''), 10);
  return isNaN(n) ? null : n;
}

export function accountSortFn(a: { uri: string }, b: { uri: string }): number {
  const nA = extractSipNumber(a.uri);
  const nB = extractSipNumber(b.uri);
  if (nA !== null && nB !== null) {
    if (nA !== nB) return nA - nB;
    return a.uri.localeCompare(b.uri);
  }
  if (nA !== null) return -1;
  if (nB !== null) return 1;
  return a.uri.localeCompare(b.uri);
}
