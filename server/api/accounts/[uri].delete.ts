import { parseAccountsFile, writeAccountsFile } from '../../services/accounts-file';

export default defineEventHandler(async (event) => {
  const encodedUri = getRouterParam(event, 'uri')!;
  const uri = decodeURIComponent(encodedUri);

  const config = useRuntimeConfig();
  const filePath = config.accountsConfigPath as string;

  const entries = await parseAccountsFile(filePath);
  const idx = entries.findIndex(e => e.uri === uri);
  if (idx === -1) {
    throw createError({ statusCode: 404, message: 'Account not found' });
  }

  entries.splice(idx, 1);
  await writeAccountsFile(filePath, entries);
  return { success: true, entries };
});
