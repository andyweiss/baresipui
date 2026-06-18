import { parseAccountsFile } from '../../services/accounts-file';

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  return parseAccountsFile(config.accountsConfigPath as string);
});
