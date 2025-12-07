import { getBaresipLogger } from '../utils/logger';

export default defineEventHandler(async (event) => {
  try {
    const logger = getBaresipLogger();
    
    // Parse query parameters manually if getQuery fails
    let limit: number | undefined;
    let level: 'debug' | 'info' | 'warn' | 'error' | undefined;
    let accountUri: string | undefined;
    
    try {
      const query = getQuery(event);
      limit = query.limit ? parseInt(query.limit as string) : undefined;
      level = query.level as 'debug' | 'info' | 'warn' | 'error' | undefined;
      accountUri = query.accountUri as string | undefined;
    } catch (e) {
      // Fallback: no filtering
      console.warn('Could not parse query parameters:', e);
    }

    let logs;
    
    if (accountUri) {
      logs = logger.getLogsByAccount(accountUri, limit);
    } else if (level) {
      logs = logger.getLogsByLevel(level, limit);
    } else {
      logs = logger.getLogs(limit);
    }

    return {
      success: true,
      logs,
      total: logs.length
    };
  } catch (error: any) {
    console.error('Error in baresip-logs API:', error);
    return {
      success: false,
      error: error.message,
      logs: [],
      total: 0
    };
  }
});
