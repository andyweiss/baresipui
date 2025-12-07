import { getBaresipConnection } from '../services/baresip-connection';
import { BaresipLogger } from '../services/baresip-logger';
import { stateManager } from '../services/state-manager';
import { setBaresipLogger } from '../utils/logger';

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();

  console.log('Initializing Baresip connection...');
  console.log(`Baresip host: ${config.baresipHost}`);
  console.log(`Baresip port: ${config.baresipPort}`);

  const connection = getBaresipConnection(
    config.baresipHost,
    parseInt(config.baresipPort as string)
  );

  connection.connect();

  // Initialize logger
  const baresipLogger = new BaresipLogger(stateManager);
  setBaresipLogger(baresipLogger);
  
  // Start streaming logs from Docker container
  const containerName = process.env.BARESIP_CONTAINER_NAME || 'baresip';
  baresipLogger.start(containerName);

  console.log('Baresip plugin initialized with logger');
});
