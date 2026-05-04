import { getBaresipConnection } from '../services/baresip-connection';
import { stateManager } from '../services/state-manager';
import { gpioToDtmf } from '~/types';

async function parseRequestBody(event: any) {
  try {
    return await readBody(event);
  } catch {
    // Fallback: readBody() fails in some Nitro versions
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
  const { accountUri, gpioIndex, state } = body;

  if (!accountUri || typeof gpioIndex !== 'number' || typeof state !== 'boolean') {
    throw createError({
      statusCode: 400,
      message: 'Required: accountUri (string), gpioIndex (1-6), state (boolean)'
    });
  }

  if (gpioIndex < 1 || gpioIndex > 6) {
    throw createError({ statusCode: 400, message: 'gpioIndex must be 1-6' });
  }

  const digit = gpioToDtmf(gpioIndex, state);

  try {
    const config = useRuntimeConfig();
    const connection = getBaresipConnection(config.baresipHost, parseInt(config.baresipPort as string));

    // Only send DTMF if the account currently has an active call.
    // Without an active call, baresip ignores uafind and falls back to
    // the last active UA — sending DTMF to the wrong account.
    const account = stateManager.getAccount(accountUri);
    const hasActiveCall = account?.callId &&
      (account.callStatus === 'In Call' || account.callStatus === 'Ringing');

    if (hasActiveCall) {
      connection.sendCommandSequence([
        { command: 'uafind', params: accountUri },
        { command: digit }
      ]);
      stateManager.addLog('info', 'tcp-socket', `GPIO ${gpioIndex} ${state ? 'ON' : 'OFF'} → DTMF ${digit}`, accountUri);
    } else {
      stateManager.addLog('debug', 'tcp-socket', `GPIO ${gpioIndex} ${state ? 'ON' : 'OFF'} saved (no active call, DTMF not sent)`, accountUri);
    }

    // Always update the GPIO state — it represents desired output state
    // and will be retransmitted when a call is established (CALL_RTPESTAB)
    stateManager.updateGpioOut(accountUri, gpioIndex, state);

    return {
      success: true,
      accountUri,
      gpioIndex,
      state,
      digit,
      dtmfSent: !!hasActiveCall,
      timestamp: Date.now()
    };
  } catch (err: any) {
    throw createError({ statusCode: 500, message: err.message || 'Failed to send DTMF' });
  }
});
