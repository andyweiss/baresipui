import { stateManager } from '../services/state-manager';

export default defineEventHandler((event) => {
  const rawUrl = event.node.req.url || '';
  const qs = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const params = new URLSearchParams(qs);
  const accountUri = params.get('account') || '';

  if (accountUri) {
    return stateManager.getGpioState(accountUri);
  }

  // Return all GPIO states (useful for ESP32 polling multiple accounts)
  return { gpioStates: stateManager.getAllGpioStates() };
});
