import { getBaresipConnection } from '../services/baresip-connection';
import { BaresipLogger } from '../services/baresip-logger';
import { stateManager } from '../services/state-manager';
import { setBaresipLogger } from '../utils/logger';

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();

  const connection = getBaresipConnection(
    config.baresipHost,
    parseInt(config.baresipPort as string)
  );

  connection.connect();

  // Initialize logger
  const baresipLogger = new BaresipLogger(stateManager);
  setBaresipLogger(baresipLogger);
  
  // Start streaming logs from shared volume
  baresipLogger.start();
});
