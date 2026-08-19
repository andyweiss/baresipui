import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionToken,
  getAuthEnv,
  getCookieValue,
  isSessionValid,
  isValidCredentials
} from '~/server/utils/auth';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('auth environment boundary', () => {
  it('is disabled unless both AUTH_USERNAME and AUTH_PASSWORD are set', () => {
    vi.stubEnv('AUTH_USERNAME', undefined);
    vi.stubEnv('AUTH_PASSWORD', undefined);
    expect(getAuthEnv().enabled).toBe(false);

    vi.stubEnv('AUTH_USERNAME', 'admin');
    expect(getAuthEnv().enabled).toBe(false);

    vi.stubEnv('AUTH_PASSWORD', 'secret');
    expect(getAuthEnv()).toMatchObject({ enabled: true, username: 'admin', password: 'secret' });
  });
});

describe('credential and session verification', () => {
  it('accepts only the configured username/password', () => {
    const env = { enabled: true, username: 'admin', password: 'secret' };
    expect(isValidCredentials('admin', 'secret', env)).toBe(true);
    expect(isValidCredentials('admin', 'wrong', env)).toBe(false);
    expect(isValidCredentials('wrong', 'secret', env)).toBe(false);
    expect(isValidCredentials('admin', 'secret', { ...env, enabled: false })).toBe(false);
  });

  it('issues a session token that verifies for the same env and rejects a tampered one', () => {
    const env = { enabled: true, username: 'admin', password: 'secret' };
    const token = createSessionToken(env);
    expect(isSessionValid(token, env)).toBe(true);
    expect(isSessionValid(token, { ...env, password: 'other' })).toBe(false);
    expect(isSessionValid(`${token}tampered`, env)).toBe(false);
    expect(isSessionValid(undefined, env)).toBe(false);
    expect(isSessionValid('not-a-token', env)).toBe(false);
  });

  it('rejects an expired session token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const env = { enabled: true, username: 'admin', password: 'secret' };
    const token = createSessionToken(env);
    expect(isSessionValid(token, env)).toBe(true);

    vi.setSystemTime(new Date('2026-02-15T00:00:00Z')); // > 30 days later
    expect(isSessionValid(token, env)).toBe(false);
  });
});

describe('cookie header parsing', () => {
  it('extracts the named cookie value among several', () => {
    expect(getCookieValue('foo=bar; baresipui_session=abc.def; other=1', 'baresipui_session')).toBe(
      'abc.def'
    );
    expect(getCookieValue('foo=bar', 'baresipui_session')).toBeUndefined();
    expect(getCookieValue(undefined, 'baresipui_session')).toBeUndefined();
  });
});
