import { AUTH_COOKIE_NAME, getAuthEnv, isSessionValid } from '../utils/auth';

const PUBLIC_EXACT_PATHS = new Set([
  '/login',
  '/favicon.ico',
  '/robots.txt',
  '/version.js',
  '/api/auth/login',
  '/api/auth/status',
  '/api/health'
]);

function isPublicPath(path: string): boolean {
  return PUBLIC_EXACT_PATHS.has(path) || path.startsWith('/_nuxt/');
}

export default defineEventHandler((event) => {
  const authEnv = getAuthEnv();
  if (!authEnv.enabled) return;

  const path = (event.node.req.url || '/').split('?')[0];
  if (isPublicPath(path)) return;

  const token = getCookie(event, AUTH_COOKIE_NAME);
  if (isSessionValid(token, authEnv)) return;

  if (path.startsWith('/api/') || path.startsWith('/socket.io/')) {
    throw createError({ statusCode: 401, message: 'Authentication required' });
  }

  return sendRedirect(event, `/login?redirect=${encodeURIComponent(path)}`, 302);
});
