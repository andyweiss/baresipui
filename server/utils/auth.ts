import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE_NAME = 'baresipui_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthEnvironment {
  enabled: boolean;
  username: string;
  password: string;
}

/**
 * Read directly from process.env (not Nuxt runtimeConfig) so credentials
 * never enter the client-visible payload, matching the pattern used for
 * other server-only secrets in this codebase.
 */
export function getAuthEnv(): AuthEnvironment {
  const username = process.env.AUTH_USERNAME?.trim() || '';
  const password = process.env.AUTH_PASSWORD?.trim() || '';
  return { enabled: Boolean(username && password), username, password };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time string comparison, safe against both value and length timing leaks. */
function secureCompare(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function isValidCredentials(username: string, password: string, env: AuthEnvironment): boolean {
  if (!env.enabled) return false;
  return secureCompare(username, env.username) && secureCompare(password, env.password);
}

function sign(env: AuthEnvironment, expiresAt: number): string {
  return createHmac('sha256', env.password).update(`${env.username}:${expiresAt}`).digest('hex');
}

export function createSessionToken(env: AuthEnvironment): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${sign(env, expiresAt)}`;
}

export function isSessionValid(token: string | undefined | null, env: AuthEnvironment): boolean {
  if (!env.enabled || !token) return false;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return false;

  const expiresAtRaw = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  return secureCompare(signature, sign(env, expiresAt));
}

/** Minimal cookie-header parser so Socket.IO's handshake (no h3 event) can reuse the same check. */
export function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}
