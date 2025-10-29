import { getBaresipConnection } from '../services/baresip-connection';

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

  console.log('Baresip plugin initialized');
});
