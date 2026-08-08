import { parseAccountsFile, writeAccountsFile } from '../../services/accounts-file';
import { getBaresipConnection } from '../../services/baresip-connection';
import { purgeLiveAccount } from '../../services/account-runtime';
import { stateManager } from '../../services/state-manager';

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

  try {
    const connection = getBaresipConnection(config.baresipHost as string, parseInt(config.baresipPort as string));
    // Purge every live UA under this AOR - uadel only removes one matching UA per call,
    // so repeated add/enable cycles can leave several duplicates registered.
    await purgeLiveAccount(connection, uri);
    connection.sendCommand('uastat'); // refresh UI immediately instead of waiting for a REGISTER event
  } catch (err) {
    console.error('accounts: live uadel failed, falling back to restart-required', err);
    stateManager.broadcast({ type: 'accountsPendingRestart', pending: true });
  }

  return { success: true, entries };
});
