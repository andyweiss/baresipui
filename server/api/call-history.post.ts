import { getCallHistoryManager } from '../services/call-history';

async function parseRequestBody(event: any) {
  try {
    return await readBody(event);
  } catch {
    return new Promise((resolve, reject) => {
      let body = '';
      event.node.req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      event.node.req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      event.node.req.on('error', reject);
    });
  }
}

export default defineEventHandler(async (event) => {
  const body: any = await parseRequestBody(event);
  const { accountUri, remoteUri, direction, displayName } = body;

  if (!accountUri || !remoteUri || !direction) {
    throw createError({ statusCode: 400, statusMessage: 'Missing required fields' });
  }

  const manager = getCallHistoryManager();
  await manager.load();
  await manager.addEntry(accountUri, remoteUri, direction, displayName);

  return { ok: true };
});
