import { readBaresipCoreConfigState } from '../../services/baresip-core-config';

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  const path = config.baresipConfigPath as string;
  const state = await readBaresipCoreConfigState(path);
  return { success: true, path, exists: state.exists, entries: state.entries };
});
