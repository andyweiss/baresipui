import { parseContactsFile } from '../../services/contacts-file';

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  return parseContactsFile(config.contactsConfigPath as string);
});
