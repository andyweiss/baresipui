import { stateManager } from '../../services/state-manager';

export default defineEventHandler(async (event) => {
  stateManager.clearLogs();
  
  return {
    success: true,
    message: 'Logs cleared',
    timestamp: Date.now()
  };
});
