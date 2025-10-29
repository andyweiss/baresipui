import { stateManager } from '../../services/state-manager';

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

  if (!enabled) {
    stateManager.updateAutoConnectStatus(decodedContact, 'Off');
  }

  return {
    success: true,
    contact: decodedContact,
    enabled
  };
});
