export function parseNetstring(data: Buffer): string[] {
  const messages: string[] = [];
  let buffer = data.toString();

  while (buffer.length > 0) {
    const colonIndex = buffer.indexOf(':');
    if (colonIndex === -1) break;

    const lengthStr = buffer.substring(0, colonIndex);
    const length = parseInt(lengthStr, 10);
    if (isNaN(length)) break;

    const startIndex = colonIndex + 1;
    const endIndex = startIndex + length;

    if (buffer.length < endIndex + 1 || buffer[endIndex] !== ',') break;

    const message = buffer.substring(startIndex, endIndex);
    messages.push(message);

    buffer = buffer.substring(endIndex + 1);
  }

  return messages;
}

export function createNetstring(data: string): string {
  const netstring = `${data.length}:${data},`;
  console.log(`Creating netstring: "${data}" -> "${netstring}"`);
  return netstring;
}
