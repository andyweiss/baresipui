import { getBaresipConnection } from '../services/baresip-connection';
import { stateManager } from '../services/state-manager';
import { createError } from 'h3';
import { readBody } from 'h3';

async function parseRequestBody(event: any) {
  try {
    return await readBody(event);
  } catch (err) {
    // Fallback manual parsing
    return new Promise((resolve, reject) => {
      let body = '';
      event.node.req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      event.node.req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
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

    if (command === 'dial' && params) {
      // params: { accountUri, target }
      const { accountUri, target } = typeof params === 'object' ? params : { accountUri: undefined, target: params };
      if (!accountUri || !target) {
        throw createError({ statusCode: 400, message: 'accountUri und target erforderlich' });
      }
      // Zuerst Account selektieren, dann wählen (wie Auto-Connect)
      connection.sendCommand('uafind', accountUri, token);
      setTimeout(() => {
        connection.sendCommand('dial', target, token);
      }, 150);
    } else if (command === 'hangup' && params) {
      // params: { accountUri }
      const { accountUri } = typeof params === 'object' ? params : { accountUri: params };
      if (!accountUri) {
        throw createError({ statusCode: 400, message: 'accountUri erforderlich' });
      }
      // Zuerst Account selektieren, dann auflegen (ohne Parameter)
      connection.sendCommand('uafind', accountUri, token);
      setTimeout(() => {
        connection.sendCommand('hangup', undefined, token);
      }, 150);
    } else if (command.startsWith('/') || (!params && typeof command === 'string' && command.includes(' '))) {
      const [cmd, ...paramsParts] = command.replace('/', '').split(' ');
      const parsedParams = paramsParts.join(' ');
      connection.sendCommand(cmd, parsedParams, token);
    } else {
      connection.sendCommand(command, params, token);
    }

    // Version aus StateManager holen (letztes Log mit type 'log' und version)
    let baresipVersion = 'unbekannt';
    const logs = stateManager.getLogs(20).reverse();
    for (const log of logs) {
      if (log.type === 'log') {
        if (log.version) {
          baresipVersion = log.version;
          break;
        }
        if (log.data && log.data.version) {
          baresipVersion = log.data.version;
          break;
        }
        if (log.log && log.log.version) {
          baresipVersion = log.log.version;
          break;
        }
      }
    }

    return {
      success: true,
      command,
      params,
      timestamp: Date.now(),
      version: baresipVersion
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
