import { parseContactsFile, writeContactsFile } from '../../services/contacts-file';
import { parseRequestBody } from '../../utils/request';
import { stateManager } from '../../services/state-manager';

export default defineEventHandler(async (event) => {
  const body = await parseRequestBody(event);
  const { name, uri } = body;

  if (!name?.trim() || !uri?.trim()) {
    throw createError({ statusCode: 400, message: 'name and uri required' });
  }
  if (!uri.startsWith('sip:')) {
    throw createError({ statusCode: 400, message: 'uri must start with sip:' });
  }

  const config = useRuntimeConfig();
  const filePath = config.contactsConfigPath as string;

  const entries = await parseContactsFile(filePath);

  if (entries.some(e => e.uri === uri)) {
    throw createError({ statusCode: 409, message: 'Contact with this URI already exists' });
  }

  entries.push({ name: name.trim(), uri: uri.trim(), presence: 'p2p' });
  await writeContactsFile(filePath, entries);

  stateManager.broadcast({ type: 'contactsPendingRestart', pending: true });

  return { success: true, entries };
});
