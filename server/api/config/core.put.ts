import { BARESIP_CONFIG_KEYS, type BaresipConfigKey } from '~/types';
import { reloadBaresipConfig } from '../../services/baresip-config-reload';
import {
  readBaresipCoreConfigState,
  updateBaresipCoreConfigAtomic,
  validateConfigValue,
  type BaresipConfigErrorCode,
} from '../../services/baresip-core-config';
import { parseRequestBody } from '../../utils/request';

const ERROR_STATUS: Record<BaresipConfigErrorCode, number> = {
  'invalid-value': 400,
  'missing-key': 400,
  'missing-file': 404,
  conflict: 409,
  'rollback-failed': 500,
};

export default defineEventHandler(async (event) => {
  const body = (await parseRequestBody(event)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Request body must be an object' });
  }

  const updates: Partial<Record<BaresipConfigKey, string>> = {};
  for (const key of BARESIP_CONFIG_KEYS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw createError({ statusCode: 400, message: `${key} must be a string` });
    }
    try {
      validateConfigValue(key, value);
    } catch (err: any) {
      throw createError({ statusCode: 400, message: err.message });
    }
    updates[key] = value;
  }

  const config = useRuntimeConfig();
  const path = config.baresipConfigPath as string;

  let changed = false;
  try {
    changed = await updateBaresipCoreConfigAtomic(path, updates);
  } catch (err: any) {
    throw createError({
      statusCode: ERROR_STATUS[err?.code as BaresipConfigErrorCode] ?? 500,
      message: err?.message || 'Failed to save config',
    });
  }

  // Always answer with what the file now contains rather than with what was
  // sent, so the client can only ever display on-disk state.
  const state = await readBaresipCoreConfigState(path);

  const reload = changed
    ? await reloadBaresipConfig(
        config.baresipHost as string,
        parseInt(config.baresipPort as string),
      )
    : { reloaded: false };

  return {
    success: true,
    changed,
    reloaded: reload.reloaded,
    reloadError: reload.error,
    path,
    exists: state.exists,
    entries: state.entries,
  };
});
