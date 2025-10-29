import { getBaresipConnection } from '../services/baresip-connection';
import { stateManager } from '../services/state-manager';

export default defineEventHandler(() => {
  const config = useRuntimeConfig();
  const connection = getBaresipConnection(config.baresipHost, parseInt(config.baresipPort));

  return {
    status: connection.isConnected() ? 'healthy' : 'unhealthy',
    tcpConnected: connection.isConnected(),
    accounts: stateManager.getAccountsSize(),
    timestamp: Date.now()
  };
});
