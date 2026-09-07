import { reloadBaresipConfig } from '../../services/baresip-config-reload';
import { readBaresipCoreConfigState } from '../../services/baresip-core-config';

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  const path = config.baresipConfigPath as string;

  const reload = await reloadBaresipConfig(
    config.baresipHost as string,
    parseInt(config.baresipPort as string),
  );
  const state = await readBaresipCoreConfigState(path);

  return {
    success: reload.reloaded,
    reloaded: reload.reloaded,
    message: reload.error,
    path,
    exists: state.exists,
    entries: state.entries,
  };
});
