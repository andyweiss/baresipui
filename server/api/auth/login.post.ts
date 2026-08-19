import { parseRequestBody } from '../../utils/request';
import { AUTH_COOKIE_NAME, SESSION_TTL_MS, createSessionToken, getAuthEnv, isValidCredentials } from '../../utils/auth';

export default defineEventHandler(async (event) => {
  const authEnv = getAuthEnv();
  if (!authEnv.enabled) {
    throw createError({ statusCode: 404, message: 'Not found' });
  }

  const body: any = await parseRequestBody(event);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!isValidCredentials(username, password, authEnv)) {
    throw createError({ statusCode: 401, message: 'Invalid username or password' });
  }

  setCookie(event, AUTH_COOKIE_NAME, createSessionToken(authEnv), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: getRequestProtocol(event) === 'https',
    maxAge: SESSION_TTL_MS / 1000
  });

  return { success: true };
});
