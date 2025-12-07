import type { BaresipLogger } from '../services/baresip-logger';

let loggerInstance: BaresipLogger | null = null;

export function setBaresipLogger(logger: BaresipLogger) {
  loggerInstance = logger;
}

export function getBaresipLogger(): BaresipLogger {
  if (!loggerInstance) {
    throw new Error('BaresipLogger not initialized');
  }
  return loggerInstance;
}
