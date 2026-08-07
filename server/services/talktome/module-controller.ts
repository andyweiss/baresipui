import type { JsonObject, JsonValue } from './types';

export interface ModuleCommandExecutor {
  /**
   * Executes a correlated ctrl_tcp command and resolves with its response.
   * The parent integration can implement this over BaresipConnection/parser.
   */
  execute(command: string, params?: string): Promise<unknown>;
}

export interface ReservedModuleSource {
  localRecvPort: number;
}

export interface ModuleSourceEndpoint {
  producerId: string;
  ip: string;
  port: number;
  payloadType: number;
  ssrc?: number;
}

export interface ModuleContextConfig {
  mixLocalCallers: boolean;
  bitrateBps: number;
}

export interface TalktomeModuleController {
  openContext(key: string): Promise<void>;
  configureContext(key: string, config: ModuleContextConfig): Promise<void>;
  closeContext(key: string): Promise<void>;
  bindTransmit(
    key: string,
    endpoint: { ip: string; port: number; payloadType: number; ssrc: number },
  ): Promise<void>;
  setTransmitMuted(key: string, muted: boolean): Promise<void>;
  reserveSource(key: string, producerId: string): Promise<ReservedModuleSource>;
  addSource(key: string, endpoint: ModuleSourceEndpoint): Promise<void>;
  removeSource(key: string, producerId: string): Promise<void>;
  getStats(key: string): Promise<JsonObject>;
}

/**
 * Exact adapter for the mediasoup_bridge custom ctrl_tcp command protocol.
 */
export class CtrlTcpTalktomeModuleController implements TalktomeModuleController {
  constructor(private readonly executor: ModuleCommandExecutor) {}

  async openContext(key: string): Promise<void> {
    await this.command('ms_ctx_open', [contextKey(key)]);
  }

  async configureContext(key: string, config: ModuleContextConfig): Promise<void> {
    if (!config || typeof config.mixLocalCallers !== 'boolean') {
      throw new Error('mixLocalCallers must be a boolean');
    }
    if (
      !Number.isSafeInteger(config.bitrateBps) ||
      config.bitrateBps < 6_000 ||
      config.bitrateBps > 510_000
    ) {
      throw new Error('bitrateBps must be an integer from 6000 to 510000');
    }
    await this.command('ms_ctx_config', [
      contextKey(key),
      config.mixLocalCallers ? 'party-line' : 'isolated',
      String(config.bitrateBps),
    ]);
  }

  async closeContext(key: string): Promise<void> {
    await this.command('ms_ctx_close', [contextKey(key)]);
  }

  async bindTransmit(
    key: string,
    endpoint: { ip: string; port: number; payloadType: number; ssrc: number },
  ): Promise<void> {
    await this.command('ms_bridge_tx', [
      contextKey(key),
      token(endpoint.ip, 'IP address'),
      port(endpoint.port),
      payloadType(endpoint.payloadType),
      positiveInteger(endpoint.ssrc, 'SSRC'),
    ]);
  }

  async setTransmitMuted(key: string, muted: boolean): Promise<void> {
    await this.command('ms_bridge_tx_mute', [
      contextKey(key),
      muted ? 'on' : 'off',
    ]);
  }

  async reserveSource(
    key: string,
    producerId: string,
  ): Promise<ReservedModuleSource> {
    const response = await this.command('ms_src_reserve', [
      contextKey(key),
      token(producerId, 'producer ID'),
    ]);
    const decoded = decodeCommandPayload(response);
    if (!isRecord(decoded)) {
      throw new Error('ms_src_reserve returned no structured response');
    }
    const localRecvPort = Number(
      decoded.localRecvPort ?? decoded.local_recv_port ?? decoded.port,
    );
    if (!Number.isSafeInteger(localRecvPort) || localRecvPort < 1 || localRecvPort > 65_535) {
      throw new Error('ms_src_reserve returned an invalid localRecvPort');
    }
    return { localRecvPort };
  }

  async addSource(key: string, endpoint: ModuleSourceEndpoint): Promise<void> {
    await this.command('ms_bridge_addsrc', [
      contextKey(key),
      token(endpoint.producerId, 'producer ID'),
      token(endpoint.ip, 'IP address'),
      port(endpoint.port),
      payloadType(endpoint.payloadType),
      ...(endpoint.ssrc === undefined
        ? []
        : [positiveInteger(endpoint.ssrc, 'SSRC')]),
    ]);
  }

  async removeSource(key: string, producerId: string): Promise<void> {
    await this.command('ms_bridge_delsrc', [
      contextKey(key),
      token(producerId, 'producer ID'),
    ]);
  }

  async getStats(key: string): Promise<JsonObject> {
    const response = await this.command('ms_bridge_stat', [contextKey(key)]);
    const decoded = decodeCommandPayload(response);
    if (!isRecord(decoded)) {
      throw new Error('ms_bridge_stat returned no structured response');
    }
    return toJsonObject(decoded);
  }

  private async command(command: string, parameters: string[]): Promise<unknown> {
    const response = await this.executor.execute(command, parameters.join(' '));
    // Validate every acknowledgement, including void commands such as mute.
    // ctrl_tcp can return a nominal response envelope with a textual failure.
    decodeCommandPayload(response);
    return response;
  }
}

function decodeCommandPayload(value: unknown): unknown {
  let candidate = value;
  if (isRecord(candidate)) {
    if (candidate.ok === false) {
      throw new Error('Module command was not acknowledged');
    }
    if (candidate.error) {
      throw new Error(
        typeof candidate.error === 'string'
          ? candidate.error
          : `Module command failed: ${JSON.stringify(candidate.error)}`,
      );
    }
    if ('data' in candidate) candidate = candidate.data;
    else if ('response' in candidate && candidate.response !== true) {
      candidate = candidate.response;
    }
  }
  if (typeof candidate !== 'string') return candidate;

  const trimmed = candidate.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
      } catch {
        // The original text below is more useful than the nested parse error.
      }
    }
    if (/\b(error|failed|invalid)\b/i.test(trimmed)) {
      throw new Error(`Module command failed: ${trimmed.slice(0, 500)}`);
    }
    return { message: trimmed };
  }
}

function contextKey(value: string): string {
  const result = token(value, 'context key');
  if (result.length > 120 || !/^[A-Za-z0-9_.:@-]+$/.test(result)) {
    throw new Error('Module context key is not command-safe');
  }
  return result;
}

function token(value: string, label: string): string {
  if (typeof value !== 'string' || !value || /[\s\0\r\n]/.test(value)) {
    throw new Error(`${label} is missing or contains command separators`);
  }
  return value;
}

function port(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Port must be an integer from 1 to 65535');
  }
  return String(value);
}

function payloadType(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 127) {
    throw new Error('RTP payload type must be an integer from 0 to 127');
  }
  return String(value);
}

function positiveInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return String(value);
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keep JsonValue referenced in declaration output for consumers implementing
// richer command response adapters.
export type ModuleCommandJsonValue = JsonValue;
