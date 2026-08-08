import { parseContactsFile, writeContactsFile } from '../../services/contacts-file';
import { stateManager } from '../../services/state-manager';
import { getBaresipConnection } from '../../services/baresip-connection';

export default defineEventHandler(async (event) => {
  const encodedUri = getRouterParam(event, 'uri')!;
  const uri = decodeURIComponent(encodedUri);

  const config = useRuntimeConfig();
  const filePath = config.contactsConfigPath as string;

  const entries = await parseContactsFile(filePath);
  const idx = entries.findIndex(e => e.uri === uri);
  if (idx === -1) {
    throw createError({ statusCode: 404, message: 'Contact not found' });
  }

  entries.splice(idx, 1);
  await writeContactsFile(filePath, entries);

  try {
    const connection = getBaresipConnection(config.baresipHost as string, parseInt(config.baresipPort as string));
    await connection.executeCommand('rmcontact', uri);
    connection.sendCommand('contacts'); // refresh UI immediately instead of waiting for the next poll
  } catch (err) {
    stateManager.broadcast({ type: 'contactsPendingRestart', pending: true });
  }

  return { success: true, entries };
});
