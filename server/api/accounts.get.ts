import { stateManager } from '../services/state-manager';

export default defineEventHandler(() => {
  return stateManager.getAccounts();
});
