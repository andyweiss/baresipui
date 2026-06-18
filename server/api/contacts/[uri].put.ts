import { parseContactsFile, writeContactsFile } from '../../services/contacts-file';
import { parseRequestBody } from '../../utils/request';
import { stateManager } from '../../services/state-manager';

export default defineEventHandler(async (event) => {
  const encodedUri = getRouterParam(event, 'uri')!;
  const oldUri = decodeURIComponent(encodedUri);
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
  const idx = entries.findIndex(e => e.uri === oldUri);
  if (idx === -1) {
    throw createError({ statusCode: 404, message: 'Contact not found' });
  }

  // If URI changed, check no conflict
  if (uri !== oldUri && entries.some(e => e.uri === uri)) {
    throw createError({ statusCode: 409, message: 'Contact with this URI already exists' });
  }

  // Preserve presence and access from existing entry
  entries[idx] = { ...entries[idx], name: name.trim(), uri: uri.trim() };
  await writeContactsFile(filePath, entries);

  stateManager.broadcast({ type: 'contactsPendingRestart', pending: true });

  return { success: true, entries };
});
