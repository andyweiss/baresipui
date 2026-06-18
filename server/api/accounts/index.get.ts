// Delegates to the top-level accounts.get.ts (stateManager runtime state)
import { stateManager } from '../../services/state-manager';

export default defineEventHandler(() => {
  return stateManager.getAccounts();
});
