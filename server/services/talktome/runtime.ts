import { isIP } from 'node:net';
import type {
  BaresipEvent,
  TalktomeAccountMapping,
  TalktomeBridgeGlobalPhase,
  TalktomeBridgeGlobalStatus,
  TalktomeBridgeServerFeedPort,
  TalktomeBridgeServerUserPort,
  TalktomeBridgeStatus,
} from '~/types';
import { dtmfToGpio, gpioToDtmf } from '~/types';
import {
  BaresipCommandError,
  type BaresipConnection,
} from '../baresip-connection';
import { registerBaresipEventObserver } from '../baresip-parser';
import {
  getTalktomeBridgeConfigManager,
  isFeedMapping,
  normalizeAccountUri,
  type TalktomeBridgeConfigManager,
} from '../talktome-bridge-config';
import { stateManager } from '../state-manager';
import { TalktomeBridgeHttpClient, type BridgeAuthMode } from './http-client';
import { CtrlTcpTalktomeModuleController } from './module-controller';
import {
  TalktomeBridgeOrchestrator,
  type TalktomeTallyUpdate,
} from './orchestrator';
import type { BridgeRuntimeConfig, JsonObject } from './types';
import { buildVirtualBridgeInventory } from './virtual-inventory';
import { withTalktomeAccountLifecycleLock } from './account-lifecycle-lock';
import {
  DEFAULT_TALKTOME_TESTED_VERSION,
  isTalktomeServerNewerThanTested,
  resolveComparableTalktomeVersion,
  resolveTalktomeTestedVersion,
} from './version';

export interface TalktomeBridgeRuntimeOptions {
  connection: BaresipConnection;
  baseUrl: string;
  bridgeId: string;
  token: string;
  mediaAnnounceIp: string;
  configPath: string;
  bridgeName?: string;
  authMode?: string;
  autoProvisionEndpoints?: boolean;
  commandTimeoutMs?: number;
  testedVersion?: string;
  /** Fallback when health/announce omit appVersion. */
  serverVersionOverride?: string;
}

export interface TalktomeBridgePublicServerConfig {
  bridgeId: string;
  revision: string;
  userPorts: TalktomeBridgeServerUserPort[];
  feedPorts: TalktomeBridgeServerFeedPort[];
}

/**
 * Globally gated integration runtime. This class is only constructed by the
 * Nitro plugin after TALKTOME_BRIDGE_ENABLED has been checked.
 */
export class TalktomeBridgeRuntime {
  private readonly configManager: TalktomeBridgeConfigManager;
  private readonly authMode: BridgeAuthMode;
  private readonly commandTimeoutMs: number;
  private readonly testedVersion: string;
  private readonly serverVersionOverride?: string;
  private orchestrator?: TalktomeBridgeOrchestrator;
  private client?: TalktomeBridgeHttpClient;
  private remoteConfig?: BridgeRuntimeConfig;
  private lifecycle: Promise<void> = Promise.resolve();
  private unregisterEventObserver?: () => void;
  private unregisterConnectionListener?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelayMs = 5_000;
  private started = false;
  private stopped = false;
  private serverVersion?: string;
  private serverNewerThanTested = false;
  private loggedNewerServerWarning = false;
  /** True after one health probe for this connection (avoids announce-interval spam). */
  private healthVersionProbeDone = false;

  constructor(private readonly options: TalktomeBridgeRuntimeOptions) {
    validateOptions(options);
    this.authMode = options.authMode === 'api-key' ? 'api-key' : 'bearer';
    this.commandTimeoutMs = validateCommandTimeout(options.commandTimeoutMs);
    this.testedVersion = resolveTalktomeTestedVersion(
      options.testedVersion,
      (invalid, fallback) =>
        stateManager.addLog(
          'warn',
          'talktome-bridge',
          `Ignoring invalid TALKTOME_TESTED_VERSION "${invalid}"; using ${fallback}`,
        ),
    );
    this.serverVersionOverride = resolveComparableTalktomeVersion(
      options.serverVersionOverride,
    );
    this.configManager = getTalktomeBridgeConfigManager(options.configPath);
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.setGlobalStatus('starting', false);

    try {
      const config = await this.configManager.load();
      for (const [accountUri, mapping] of Object.entries(config.accounts)) {
        this.seedAccountStatus(accountUri, mapping);
      }

      this.unregisterEventObserver = registerBaresipEventObserver((event) => {
        void this.handleBaresipEvent(event).catch((error) => {
          this.reportError(error);
        });
      });
      this.unregisterConnectionListener =
        this.options.connection.onConnectionStatusChange((connected) => {
          void this.enqueueLifecycle(() =>
            connected ? this.handleConnected() : this.handleDisconnected(),
          );
        });

      await this.enqueueLifecycle(() =>
        this.options.connection.isConnected()
          ? this.handleConnected()
          : this.handleDisconnected(),
      );
    } catch (error) {
      this.setGlobalStatus('failed', false, errorMessage(error));
      this.reportError(error);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unregisterEventObserver?.();
    this.unregisterConnectionListener?.();
    this.unregisterEventObserver = undefined;
    this.unregisterConnectionListener = undefined;
    this.clearRetry();
    this.setGlobalStatus('stopping', false);
    await this.enqueueLifecycle(async () => {
      const orchestrator = this.orchestrator;
      this.orchestrator = undefined;
      this.client = undefined;
      this.remoteConfig = undefined;
      await orchestrator?.stop();
    });
  }

  async refreshAccount(accountUri: string): Promise<void> {
    const uri = normalizeAccountUri(accountUri);
    await withTalktomeAccountLifecycleLock(uri, () =>
      this.refreshAccountLocked(uri),
    );
  }

  private async refreshAccountLocked(uri: string): Promise<void> {
    const mapping = this.configManager.getAccount(uri);
    if (mapping && !stateManager.getTalktomeBridgeStatus(uri)) {
      this.seedAccountStatus(uri, mapping);
    }

    const orchestrator = this.orchestrator;
    if (!orchestrator) {
      if (!mapping) stateManager.removeTalktomeBridgeStatus(uri);
      throw new Error('Talktome bridge runtime is not connected');
    }
    await orchestrator.refreshAccount(uri);
    if (
      !mapping &&
      orchestrator.getStatus(uri)?.phase !== 'stopping'
    ) {
      stateManager.removeTalktomeBridgeStatus(uri);
    }

    if (mapping?.enabled) {
      for (const call of stateManager.getCalls()) {
        if (
          call.localUri.toLowerCase().trim() === uri &&
          call.state === 'Established'
        ) {
          await orchestrator.callEstablished(uri, call.callId);
        }
      }
    }
    await this.refreshServerConfig();
  }

  async refreshServerConfig(): Promise<TalktomeBridgePublicServerConfig | undefined> {
    if (!this.client) return this.getPublicServerConfig();
    try {
      this.remoteConfig = await this.client.getConfig(this.options.bridgeId);
      this.setGlobalStatus(
        this.orchestrator ? 'connected' : 'starting',
        true,
      );
    } catch (error) {
      this.setGlobalStatus('degraded', false, errorMessage(error));
      this.reportError(error);
    }
    return this.getPublicServerConfig();
  }

  getPublicServerConfig(): TalktomeBridgePublicServerConfig | undefined {
    if (!this.remoteConfig) return undefined;
    return {
      bridgeId: this.remoteConfig.bridgeId,
      revision: this.remoteConfig.revision,
      userPorts: this.remoteConfig.ports
        .filter((port) => port.kind === 'user')
        .map((port) => ({
          id: port.id,
          kind: 'user',
          userId: port.userId,
          label: port.label,
          enabled: port.enabled,
          trigger: {
            mode: port.trigger.mode,
            target: port.trigger.target
              ? { ...port.trigger.target }
              : null,
            thresholdDb: port.trigger.thresholdDb,
          },
          triggerTargets: port.triggerTargets.map((target) => ({
            ...target,
          })),
        })),
      feedPorts: this.remoteConfig.ports
        .filter((port) => port.kind === 'feed')
        .map((port) => ({
          id: port.id,
          kind: 'feed',
          feedId: port.feedId,
          label: port.label,
          enabled: port.enabled,
          input: { ...port.input },
        })),
    };
  }

  private async handleConnected(): Promise<void> {
    if (this.stopped || !this.options.connection.isConnected()) return;
    this.setGlobalStatus('starting', false);

    const previous = this.orchestrator;
    this.orchestrator = undefined;
    if (previous) await previous.stop();

    try {
      await this.refreshCallInventory();
      await this.loadModule();
      if (!this.options.connection.isConnected()) {
        throw new Error('Baresip disconnected while loading the bridge module');
      }

      const client = new TalktomeBridgeHttpClient({
        baseUrl: this.options.baseUrl,
        token: this.options.token,
        authMode: this.authMode,
        // The announced token is scoped to this bridge and is authorized to
        // update its own endpoint configuration.
        adoptAnnouncedBridgeToken: true,
      });
      const module = new CtrlTcpTalktomeModuleController({
        execute: (command, params) =>
          this.options.connection.executeCommand(command, params, {
            timeoutMs: this.commandTimeoutMs,
          }),
      });
      const orchestrator = new TalktomeBridgeOrchestrator({
        enabled: true,
        bridgeId: this.options.bridgeId,
        api: client,
        module,
        mappings: this.configManager,
        autoProvisionEndpoints: this.options.autoProvisionEndpoints !== false,
        announcement: {
          bridgeId: this.options.bridgeId,
          name: this.options.bridgeName || 'baresipui',
          platform: `baresipui-${process.platform}`,
          inventory: buildVirtualBridgeInventory(this.options.mediaAnnounceIp),
        },
        callbacks: {
          onStatus: (status) => this.handleOrchestratorStatus(status),
          onTally: (update) => this.handleTally(update),
          onAnnouncement: (announcement) => {
            this.remoteConfig = announcement.config;
            // Periodic announce keep-alives should not re-hit /health when the
            // server still omits appVersion (talktome v1.1.3). Only refresh when
            // announce itself carries a version; startup probes once below.
            if (announcement.appVersion) {
              void this.refreshServerVersion(client, announcement.appVersion);
            }
          },
          onError: (error, accountUri) => this.reportError(error, accountUri),
        },
      });

      const announcement = await orchestrator.initialize();
      this.client = client;
      this.remoteConfig =
        announcement?.config ??
        this.remoteConfig ??
        (await client.getConfig(this.options.bridgeId));
      this.orchestrator = orchestrator;
      await this.refreshServerVersion(client, announcement?.appVersion);

      for (const call of stateManager.getCalls()) {
        if (call.state === 'Established') {
          await withTalktomeAccountLifecycleLock(call.localUri, async () => {
            if (this.orchestrator !== orchestrator) return;
            await orchestrator.callEstablished(call.localUri, call.callId);
          });
        }
      }
      this.clearRetry();
      this.retryDelayMs = 5_000;
      this.setGlobalStatus('connected', true);
    } catch (error) {
      this.client = undefined;
      this.remoteConfig = undefined;
      if (this.options.connection.isConnected()) {
        this.setGlobalStatus('failed', false, errorMessage(error));
      } else {
        this.setGlobalStatus('waiting-baresip', false, errorMessage(error));
      }
      this.reportError(error);
      if (this.options.connection.isConnected()) this.scheduleRetry();
    }
  }

  private async handleDisconnected(): Promise<void> {
    if (this.stopped) return;
    this.clearRetry();
    this.retryDelayMs = 5_000;
    this.serverVersion = undefined;
    this.serverNewerThanTested = false;
    this.loggedNewerServerWarning = false;
    this.healthVersionProbeDone = false;
    this.setGlobalStatus('waiting-baresip', false);
    const orchestrator = this.orchestrator;
    this.orchestrator = undefined;
    this.client = undefined;
    this.remoteConfig = undefined;
    await orchestrator?.stop();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.enqueueLifecycle(() => this.handleConnected());
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async loadModule(): Promise<void> {
    try {
      const response = await this.options.connection.executeCommand(
        'insmod',
        'mediasoup_bridge.so',
        { timeoutMs: this.commandTimeoutMs },
      );
      const responseText =
        typeof response.data === 'string' ? response.data.trim() : '';
      if (
        responseText &&
        (/\bERROR\b/.test(responseText) ||
          /(?:^|\n)\s*failed\b/i.test(responseText))
      ) {
        if (/\b(already|exists|loaded)\b/i.test(responseText)) return;
        throw new BaresipCommandError(
          `Baresip insmod failed: ${responseText.slice(0, 500)}`,
          response,
        );
      }
    } catch (error) {
      const responseText =
        error instanceof BaresipCommandError
          ? String(error.response?.data || error.message)
          : errorMessage(error);
      if (!/\b(already|exists|loaded)\b/i.test(responseText)) throw error;
    }
  }

  private async refreshCallInventory(): Promise<void> {
    stateManager.clearCalls();
    stateManager.setAllCallStatus('Idle');
    const response = await this.options.connection.executeCommand(
      'listcalls',
      undefined,
      { timeoutMs: this.commandTimeoutMs },
    );
    const responseText =
      typeof response.data === 'string' ? response.data.trim() : '';
    if (
      /\bERROR\b/.test(responseText) ||
      /(?:^|\n)\s*(?:failed|invalid)\b/i.test(responseText) ||
      !/\b(?:active calls?|no active calls?|no calls)\b/i.test(responseText)
    ) {
      throw new BaresipCommandError(
        `Baresip listcalls inventory failed: ${responseText.slice(0, 500)}`,
        response,
      );
    }
  }

  private async handleBaresipEvent(event: BaresipEvent): Promise<void> {
    if (this.stopped) return;
    const eventType = event.type || '';
    const rawAccountUri =
      event.accountaor || event.localuri || event.local_uri;
    if (
      (eventType === 'CALL_ESTABLISHED' || eventType === 'CALL_RTPESTAB') &&
      rawAccountUri &&
      event.id
    ) {
      await withTalktomeAccountLifecycleLock(rawAccountUri, async () => {
        const orchestrator = this.orchestrator;
        if (orchestrator) {
          await orchestrator.callEstablished(rawAccountUri, event.id!);
        }
      });
      return;
    }
    if (
      (eventType === 'CALL_CLOSED' ||
        eventType === 'CALL_END' ||
        eventType === 'CALL_TERMINATE') &&
      rawAccountUri
    ) {
      await withTalktomeAccountLifecycleLock(rawAccountUri, async () => {
        const orchestrator = this.orchestrator;
        if (!orchestrator) return;
        if (event.id) await orchestrator.callEnded(rawAccountUri, event.id);
        else await orchestrator.allCallsEnded(rawAccountUri);
      });
      return;
    }
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    if (
      (eventType === 'CALL_DTMF_START' || eventType === 'CALL_DTMF') &&
      rawAccountUri &&
      event.param
    ) {
      const uri = normalizeAccountUri(rawAccountUri);
      const mapping = this.configManager.getAccount(uri);
      const gpio = dtmfToGpio(event.param.trim());
      if (
        mapping?.enabled &&
        !isFeedMapping(mapping) &&
        mapping.ptt.mode === 'external' &&
        gpio?.gpioIndex === mapping.ptt.gpi &&
        event.id
      ) {
        await orchestrator.setExternalPtt(
          uri,
          event.id,
          gpio.state,
        );
      }
      return;
    }

    const telemetry = parseModuleTelemetry(event);
    if (!telemetry) return;
    const accountUri = this.accountUriForKey(telemetry.payload.key);
    if (!accountUri) return;
    switch (telemetry.name) {
      case 'MS_TX_ACTIVE': {
        const dbfs = Number(telemetry.payload.dbfs);
        if (Number.isFinite(dbfs)) {
          await orchestrator.updateVadLevel(accountUri, dbfs);
        }
        break;
      }
      case 'MS_RX_LEVEL': {
        const producerId = stringValue(telemetry.payload.producerId);
        if (producerId && typeof telemetry.payload.active === 'boolean') {
          await orchestrator.setReceiveActivity(
            accountUri,
            producerId,
            telemetry.payload.active,
          );
        }
        break;
      }
      case 'MS_RX_ACTIVE':
        if (typeof telemetry.payload.active === 'boolean') {
          await orchestrator.setAggregateReceiveActivity(
            accountUri,
            telemetry.payload.active,
          );
        }
        break;
      case 'MS_CTX_ERROR':
        await orchestrator.reportModuleError(
          accountUri,
          stringValue(telemetry.payload.reason) || 'unknown module error',
        );
        break;
      default:
        break;
    }
  }

  private async handleTally(update: TalktomeTallyUpdate): Promise<void> {
    stateManager.updateGpioOut(update.accountUri, update.gpo, update.active);
    const activeCalls = stateManager.getCalls().filter(
      (call) =>
        call.localUri.toLowerCase().trim() ===
          update.accountUri.toLowerCase().trim() &&
        call.state !== 'Closing',
    );
    if (!activeCalls.length || !this.options.connection.isConnected()) return;

    const digit = gpioToDtmf(update.gpo, update.active);
    for (const call of activeCalls) {
      try {
        await this.options.connection.executeCommandSequence(
          [
            { command: 'callfind', params: call.callId },
            { command: digit },
          ],
          { timeoutMs: this.commandTimeoutMs },
        );
      } catch (error) {
        this.reportError(error, update.accountUri);
      }
    }
  }

  private accountUriForKey(value: unknown): string | undefined {
    const key = stringValue(value);
    if (!key) return undefined;
    for (const [accountUri, mapping] of Object.entries(
      this.configManager.getConfig().accounts,
    )) {
      if (mapping.key === key) return accountUri;
    }
    return undefined;
  }

  private seedAccountStatus(
    accountUri: string,
    mapping: TalktomeAccountMapping,
  ): void {
    const status: TalktomeBridgeStatus = {
      accountUri,
      key: mapping.key,
      phase: mapping.enabled ? 'idle' : 'disabled',
      activeCallIds: [],
      consumerCount: 0,
      pttLive: false,
      pttLocked: false,
      eventTransport: 'disconnected',
      updatedAt: Date.now(),
    };
    stateManager.setTalktomeBridgeStatus(status);
  }

  private handleOrchestratorStatus(status: TalktomeBridgeStatus): void {
    stateManager.setTalktomeBridgeStatus(status);
    const global = stateManager.getTalktomeBridgeGlobalStatus();
    if (
      global.phase === 'degraded' &&
      global.serverReachable &&
      !stateManager
        .getTalktomeBridgeStatuses()
        .some((candidate) =>
          candidate.phase === 'degraded' || candidate.phase === 'failed',
        )
    ) {
      this.setGlobalStatus('connected', true);
    }
  }

  private setGlobalStatus(
    phase: TalktomeBridgeGlobalPhase,
    serverReachable: boolean,
    lastError?: string,
  ): void {
    const status: TalktomeBridgeGlobalStatus = {
      enabled: true,
      phase,
      baresipConnected: this.options.connection.isConnected(),
      serverReachable,
      testedVersion: this.testedVersion,
      ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}),
      ...(this.serverNewerThanTested ? { serverNewerThanTested: true } : {}),
      ...(lastError ? { lastError } : {}),
      updatedAt: Date.now(),
    };
    stateManager.setTalktomeBridgeGlobalStatus(status);
  }

  private async refreshServerVersion(
    client: TalktomeBridgeHttpClient,
    announcedVersion?: string,
  ): Promise<void> {
    let next = resolveComparableTalktomeVersion(announcedVersion);
    if (!next && !this.healthVersionProbeDone) {
      this.healthVersionProbeDone = true;
      try {
        const health = await client.getHealth();
        next = resolveComparableTalktomeVersion(health.appVersion);
      } catch {
        // Health is best-effort; keep any previously observed version.
      }
    }
    if (!next) next = this.serverVersionOverride;
    if (!next || next === this.serverVersion) return;

    this.serverVersion = next;
    this.serverNewerThanTested = isTalktomeServerNewerThanTested(
      next,
      this.testedVersion,
    );
    if (this.serverNewerThanTested && !this.loggedNewerServerWarning) {
      this.loggedNewerServerWarning = true;
      stateManager.addLog(
        'warn',
        'talktome-bridge',
        `TalkToMe server version ${next} is newer than tested version ${this.testedVersion}; bridge behavior may differ`,
      );
    }
    const current = stateManager.getTalktomeBridgeGlobalStatus();
    this.setGlobalStatus(
      current.phase === 'disabled' ? 'starting' : current.phase,
      current.serverReachable,
      current.lastError,
    );
  }

  private reportError(error: unknown, accountUri?: string): void {
    const message = errorMessage(error);
    stateManager.addLog('error', 'talktome-bridge', message, accountUri);
    if (this.options.connection.isConnected()) {
      const current = stateManager.getTalktomeBridgeGlobalStatus();
      if (current.phase === 'connected') {
        this.setGlobalStatus('degraded', current.serverReachable, message);
      }
    }
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch((error) => {
      this.reportError(error);
    });
    return result;
  }
}

let runtime: TalktomeBridgeRuntime | undefined;

export function setTalktomeBridgeRuntime(
  value: TalktomeBridgeRuntime | undefined,
): void {
  runtime = value;
}

export function getTalktomeBridgeRuntime(): TalktomeBridgeRuntime | undefined {
  return runtime;
}

function validateOptions(options: TalktomeBridgeRuntimeOptions): void {
  const required: Array<[string, string]> = [
    ['TALKTOME_BASE_URL', options.baseUrl],
    ['TALKTOME_BRIDGE_ID', options.bridgeId],
    ['TALKTOME_BRIDGE_TOKEN', options.token],
    ['TALKTOME_MEDIA_ANNOUNCE_IP', options.mediaAnnounceIp],
  ];
  const missing = required
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing required talktome environment: ${missing.join(', ')}`);
  }
  if (isIP(options.mediaAnnounceIp.trim()) === 0) {
    throw new Error('TALKTOME_MEDIA_ANNOUNCE_IP must be an IPv4 or IPv6 address');
  }
  if (options.authMode && !['bearer', 'api-key'].includes(options.authMode)) {
    throw new Error('TALKTOME_BRIDGE_AUTH_MODE must be bearer or api-key');
  }
}

function validateCommandTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new Error('Talktome command timeout must be between 100 and 120000 ms');
  }
  return timeout;
}

function parseModuleTelemetry(
  event: BaresipEvent,
): { name: string; payload: JsonObject } | undefined {
  if (event.type !== 'MODULE' || typeof event.param !== 'string') return undefined;
  const firstComma = event.param.indexOf(',');
  const secondComma =
    firstComma < 0 ? -1 : event.param.indexOf(',', firstComma + 1);
  if (firstComma < 0 || secondComma < 0) return undefined;
  if (event.param.slice(0, firstComma).trim() !== 'mediasoup_bridge') {
    return undefined;
  }
  const name = event.param.slice(firstComma + 1, secondComma).trim();
  try {
    const payload = JSON.parse(event.param.slice(secondComma + 1)) as unknown;
    if (!isRecord(payload)) return undefined;
    return { name, payload: payload as JsonObject };
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
