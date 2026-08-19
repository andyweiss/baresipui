import { AUTH_COOKIE_NAME, getAuthEnv, isSessionValid } from '../../utils/auth';

export default defineEventHandler((event) => {
  const authEnv = getAuthEnv();
  if (!authEnv.enabled) {
    return { enabled: false, authenticated: true };
  }

  const token = getCookie(event, AUTH_COOKIE_NAME);
  return { enabled: true, authenticated: isSessionValid(token, authEnv) };
});
