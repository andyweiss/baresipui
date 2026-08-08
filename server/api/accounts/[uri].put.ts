import { parseAccountsFile, writeAccountsFile } from '../../services/accounts-file';
import { parseRequestBody } from '../../utils/request';
import { getBaresipConnection } from '../../services/baresip-connection';
import { syncLiveAccount } from '../../services/account-runtime';
import { stateManager } from '../../services/state-manager';
import type { AccountFileEntry } from '~/types';

const SENTINEL_PASSWORD = '********';

export default defineEventHandler(async (event) => {
  const encodedUri = getRouterParam(event, 'uri')!;
  const oldUri = decodeURIComponent(encodedUri);
  const body = await parseRequestBody(event);
  const update = body as AccountFileEntry & { auth_pass: string | null };

  if (!update.name?.trim() || !update.uri?.trim()) {
    throw createError({ statusCode: 400, message: 'name and uri required' });
  }
  if (!update.uri.startsWith('sip:')) {
    throw createError({ statusCode: 400, message: 'uri must start with sip:' });
  }

  const config = useRuntimeConfig();
  const filePath = config.accountsConfigPath as string;

  const entries = await parseAccountsFile(filePath);
  const idx = entries.findIndex(e => e.uri === oldUri);
  if (idx === -1) {
    throw createError({ statusCode: 404, message: 'Account not found' });
  }

  const newUri = update.uri.trim();
  if (newUri !== oldUri && entries.some(e => e.uri === newUri)) {
    throw createError({ statusCode: 409, message: 'Account with this URI already exists' });
  }

  const keepPassword = !update.auth_pass || update.auth_pass === SENTINEL_PASSWORD;
  const auth_pass = keepPassword ? entries[idx].auth_pass : update.auth_pass;

  const newEntry: AccountFileEntry = {
    name: update.name.trim(),
    uri: newUri,
    enabled: update.enabled !== false,
    transport: update.transport || 'udp',
    auth_pass,
    answermode: update.answermode || 'auto',
    regint: update.regint || 360,
    audio_source: update.audio_source || '',
    audio_player: update.audio_player || '',
    pubint: update.pubint ?? 0,
    inreq_allowed: update.inreq_allowed !== false
  };
  entries[idx] = newEntry;

  await writeAccountsFile(filePath, entries);

  try {
    const connection = getBaresipConnection(config.baresipHost as string, parseInt(config.baresipPort as string));
    // Baresip has no in-place account editor - purge every live UA under the old (and new,
    // in case of leftover duplicates) AOR, then recreate if enabled. uadel only removes one
    // matching UA per call, so syncLiveAccount retries until none are left.
    await syncLiveAccount(connection, newEntry, oldUri);
    connection.sendCommand('uastat'); // refresh UI immediately instead of waiting for a REGISTER event
  } catch (err) {
    console.error('accounts: live uadel/uanew failed, falling back to restart-required', err);
    stateManager.broadcast({ type: 'accountsPendingRestart', pending: true });
  }

  return { success: true, entries };
});
