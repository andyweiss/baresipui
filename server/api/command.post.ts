import { getBaresipConnection } from '../services/baresip-connection';
import { stateManager } from '../services/state-manager';

async function parseRequestBody(event: any) {
  try {
    return await readBody(event);
  } catch {
    // Fallback: readBody() fails in some Nitro versions (event.req.text not a function)
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
  const { command, params, token } = body;

  if (!command) {
    throw createError({
      statusCode: 400,
      message: 'Command required'
    });
  }

  console.log(`Received command from frontend: ${command}${params ? ' with params: ' + params : ''}`);

  try {
    const config = useRuntimeConfig();
    const connection = getBaresipConnection(config.baresipHost, parseInt(config.baresipPort));

    if (command === 'sysinfo') {
      // Send sysinfo and wait for response to be processed
      connection.sendCommand('sysinfo', params, token);
      
      // Wait for response to be parsed and state updated (fixed delay)
      await new Promise(r => setTimeout(r, 250));
      
      const baresipInfo = stateManager.getBaresipInfo();
      
      return {
        success: true,
        command,
        params,
        timestamp: Date.now(),
        ...baresipInfo
      };
    }

    // Standard logic for other commands
    if (command === 'dial' && params) {
      const { accountUri, target } = typeof params === 'object' ? params : { accountUri: undefined, target: params };
      if (!accountUri || !target) {
        throw createError({ statusCode: 400, message: 'accountUri and target required' });
      }
      // Use serialized command sequence to prevent uafind race conditions
      // No delay needed - TCP ordering guarantees sequential processing in baresip
      connection.sendCommandSequence([
        { command: 'uafind', params: accountUri, token },
        { command: 'dial', params: target, token }
      ]);
    } else if (command === 'hangup' && params) {
      const { accountUri } = typeof params === 'object' ? params : { accountUri: params };
      if (!accountUri) {
        throw createError({ statusCode: 400, message: 'accountUri required' });
      }
      // Guard: only send hangup if account actually has an active call
      const account = stateManager.getAccount(accountUri);
      if (!account || (account.callStatus !== 'In Call' && account.callStatus !== 'Ringing')) {
        console.log(`Hangup ignored for ${accountUri}: no active call (status: ${account?.callStatus || 'unknown'})`);
        return { success: true, command, params, timestamp: Date.now(), ignored: true, reason: 'no active call' };
      }
      // Use serialized command sequence to prevent uafind race conditions
      connection.sendCommandSequence([
        { command: 'uafind', params: accountUri, token },
        { command: 'hangup', token }
      ]);
    } else if (command.startsWith('/') || (!params && typeof command === 'string' && command.includes(' '))) {
      const [cmd, ...paramsParts] = command.replace('/', '').split(' ');
      const parsedParams = paramsParts.join(' ');
      connection.sendCommand(cmd, parsedParams, token);
    } else {
      connection.sendCommand(command, params, token);
    }

    // Fallback: include baresipInfo in response
    const baresipInfo = stateManager.getBaresipInfo();
    return {
      success: true,
      command,
      params,
      timestamp: Date.now(),
      ...baresipInfo
    };
  } catch (error: any) {
    console.error('Command execution error:', error);
    throw createError({
      statusCode: 500,
      message: 'Command execution failed',
      data: { details: error.message }
    });
  }
});
