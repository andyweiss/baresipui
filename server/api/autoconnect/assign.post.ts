import { stateManager } from '../../services/state-manager';
import { getAutoConnectConfigManager } from '../../services/autoconnect-config';
import { checkAutoConnectForAccount } from '../../services/baresip-parser';

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
  const body: any = await parseRequestBody(event);
  const { account, contact } = body;

  if (!account) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Account is required'
    });
  }

  const configManager = getAutoConnectConfigManager();

  // Get account
  const accountData = stateManager.getAccount(account);
  
  if (!accountData) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Account not found'
    });
  }

  // Update account with assigned contact
  if (contact) {
    accountData.autoConnectContact = contact;
    await configManager.setContactAccount(account, contact);
  } else {
    // Clear assignment - set to undefined instead of delete
    accountData.autoConnectContact = undefined;
    await configManager.setContactAccount(account, '');
  }
  
  stateManager.setAccount(account, accountData);

  // Broadcast update
  stateManager.broadcast({
    type: 'accountStatus',
    data: accountData
  });

  if (contact) {
    checkAutoConnectForAccount(account, stateManager);
  }

  return {
    success: true,
    account,
    contact: contact || null
  };
});
