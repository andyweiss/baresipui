import { getCallHistoryManager } from '../services/call-history';

export default defineEventHandler(async (event) => {
  // Parse query from raw URL (getQuery has issues in this Nitro version)
  const rawUrl = event.node.req.url || '';
  const qs = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const params = new URLSearchParams(qs);
  const accountUri = params.get('account') || '';

  if (!accountUri) {
    throw createError({ statusCode: 400, statusMessage: 'Missing account parameter' });
  }

  const manager = getCallHistoryManager();
  await manager.load();
  const history = manager.getHistory(accountUri);

  return { history };
});
