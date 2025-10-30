import { stateManager } from '../services/state-manager';

export default defineEventHandler((event) => {
  return {
    logs: stateManager.getLogs(),
    timestamp: Date.now()
  };
});
