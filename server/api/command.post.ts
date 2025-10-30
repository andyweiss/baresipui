import { getBaresipConnection } from '../services/baresip-connection';

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

    if (command.startsWith('/') || (!params && typeof command === 'string' && command.includes(' '))) {
      const [cmd, ...paramsParts] = command.replace('/', '').split(' ');
      const parsedParams = paramsParts.join(' ');
      connection.sendCommand(cmd, parsedParams, token);
    } else {
      connection.sendCommand(command, params, token);
    }

    return {
      success: true,
      command,
      params,
      timestamp: Date.now()
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
