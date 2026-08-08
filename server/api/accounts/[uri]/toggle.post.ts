import { parseAccountsFile, writeAccountsFile } from '../../../services/accounts-file';
import { getBaresipConnection } from '../../../services/baresip-connection';
import { syncLiveAccount } from '../../../services/account-runtime';
import { stateManager } from '../../../services/state-manager';

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

  entries[idx].enabled = !entries[idx].enabled;
  await writeAccountsFile(filePath, entries);

  try {
    const connection = getBaresipConnection(config.baresipHost as string, parseInt(config.baresipPort as string));
    // Purges every live UA under this AOR first (uadel only removes one match per call),
    // then recreates it if the toggle switched it back on.
    await syncLiveAccount(connection, entries[idx]);
    connection.sendCommand('uastat'); // refresh UI immediately instead of waiting for a REGISTER event
  } catch (err) {
    console.error('accounts: live uanew/uadel failed, falling back to restart-required', err);
    stateManager.broadcast({ type: 'accountsPendingRestart', pending: true });
  }

  return { success: true, enabled: entries[idx].enabled, entries };
});
