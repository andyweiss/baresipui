import { parseAccountsFile, writeAccountsFile } from '../../services/accounts-file';
import { parseRequestBody } from '../../utils/request';
import { getBaresipConnection } from '../../services/baresip-connection';
import { syncLiveAccount } from '../../services/account-runtime';
import { stateManager } from '../../services/state-manager';
import type { AccountFileEntry } from '~/types';

export default defineEventHandler(async (event) => {
  const body = await parseRequestBody(event);
  const entry = body as AccountFileEntry;

  if (!entry.name?.trim() || !entry.uri?.trim()) {
    throw createError({ statusCode: 400, message: 'name and uri required' });
  }
  if (!entry.uri.startsWith('sip:')) {
    throw createError({ statusCode: 400, message: 'uri must start with sip:' });
  }

  const config = useRuntimeConfig();
  const entries = await parseAccountsFile(config.accountsConfigPath as string);

  if (entries.some(e => e.uri === entry.uri)) {
    throw createError({ statusCode: 409, message: 'Account with this URI already exists' });
  }

  const newEntry: AccountFileEntry = {
    name: entry.name.trim(),
    uri: entry.uri.trim(),
    enabled: entry.enabled !== false,
    transport: entry.transport || 'udp',
    auth_pass: entry.auth_pass || '',
    answermode: entry.answermode || 'auto',
    regint: entry.regint || 360,
    audio_source: entry.audio_source || '',
    audio_player: entry.audio_player || '',
    pubint: entry.pubint ?? 0,
    inreq_allowed: entry.inreq_allowed !== false
  };
  entries.push(newEntry);

  await writeAccountsFile(config.accountsConfigPath as string, entries);

  try {
    const connection = getBaresipConnection(config.baresipHost as string, parseInt(config.baresipPort as string));
    await syncLiveAccount(connection, newEntry);
    connection.sendCommand('uastat'); // refresh UI immediately instead of waiting for a REGISTER event
  } catch (err) {
    console.error('accounts: live uanew failed, falling back to restart-required', err);
    stateManager.broadcast({ type: 'accountsPendingRestart', pending: true });
  }

  return { success: true, entries };
});
