import { stateManager } from '../../services/state-manager';
import { getAutoConnectConfigManager } from '../../services/autoconnect-config';

async function parseRequestBody(event: any) {
  try {
    return await readBody(event);
  } catch {
    return new Promise((resolve, reject) => {
      let body = '';
      event.node.req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      event.node.req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      event.node.req.on('error', reject);
    });
  }
}

export default defineEventHandler(async (event) => {
  const contact = getRouterParam(event, 'contact');
  const body = await parseRequestBody(event);
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
