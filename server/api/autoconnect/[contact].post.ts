import { stateManager } from '../../services/state-manager';
import { getAutoConnectConfigManager } from '../../services/autoconnect-config';

export default defineEventHandler(async (event) => {
  const contact = getRouterParam(event, 'contact');
  const body = await readBody(event);
  const { enabled } = body;

  if (!contact) {
    throw createError({
      statusCode: 400,
      message: 'Contact parameter required'
    });
  }

  const decodedContact = decodeURIComponent(contact);
  const config = stateManager.getContactConfig(decodedContact) || {
    name: decodedContact,
    status: 'Off',
    enabled: false
  };

  config.enabled = enabled;
  stateManager.setContactConfig(decodedContact, config);

  // Save to persistent config
  const configManager = getAutoConnectConfigManager();
  await configManager.setContactEnabled(decodedContact, enabled);

  if (!enabled) {
    stateManager.updateAutoConnectStatus(decodedContact, 'Off');
  }

  // Broadcast update
  stateManager.broadcast({
    type: 'contactsUpdate',
    contacts: stateManager.getContacts()
  });

  return {
    success: true,
    contact: decodedContact,
    enabled
  };
});
