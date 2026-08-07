import { getBaresipConnection } from '../services/baresip-connection';
import { stateManager } from '../services/state-manager';
import {
  TalktomeBridgeRuntime,
  setTalktomeBridgeRuntime,
} from '../services/talktome/runtime';
import { resolveTalktomeBridgeId } from '../services/talktome/bridge-identity';
import { readTalktomeBridgeEnvironment } from '../services/talktome/env';
import { getTalktomeBridgeConfigManager } from '../services/talktome-bridge-config';
import { recoverTalktomeMappingJournal } from '../services/talktome/transaction-journal';

export default defineNitroPlugin(async (nitroApp) => {
  if (process.env.TALKTOME_BRIDGE_ENABLED !== 'true') {
    stateManager.setTalktomeBridgeGlobalStatus({
      enabled: false,
      phase: 'disabled',
      baresipConnected: stateManager.getBaresipConnected(),
      serverReachable: false,
      updatedAt: Date.now(),
    });
    return;
  }

  let environment: ReturnType<typeof readTalktomeBridgeEnvironment>;
  try {
    environment = readTalktomeBridgeEnvironment();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stateManager.setTalktomeBridgeGlobalStatus({
      enabled: true,
      phase: 'failed',
      baresipConnected: stateManager.getBaresipConnected(),
      serverReachable: false,
      lastError: message,
      updatedAt: Date.now(),
    });
    stateManager.addLog('error', 'talktome-bridge', message);
    return;
  }

  try {
    const manager = getTalktomeBridgeConfigManager(environment.configPath);
    const recovered = await recoverTalktomeMappingJournal(
      manager,
      environment.accountsConfigPath,
    );
    if (recovered) {
      stateManager.addLog(
        'warn',
        'talktome-bridge',
        'Recovered an interrupted talktome account mapping transaction',
      );
    }
  } catch (error) {
    const message = `Talktome transaction journal recovery failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    stateManager.setTalktomeBridgeGlobalStatus({
      enabled: environment.enabled,
      phase: environment.enabled ? 'failed' : 'disabled',
      baresipConnected: stateManager.getBaresipConnected(),
      serverReachable: false,
      lastError: message,
      updatedAt: Date.now(),
    });
    stateManager.addLog('error', 'talktome-bridge', message);
    return;
  }

  let bridgeId: string;
  try {
    const resolved = await resolveTalktomeBridgeId({
      configuredId: environment.bridgeId,
      configPath: environment.configPath,
    });
    bridgeId = resolved.bridgeId;
    if (resolved.source === 'generated') {
      stateManager.addLog(
        'info',
        'talktome-bridge',
        `Generated and persisted talktome bridge id ${bridgeId} at ${resolved.identityPath}`,
      );
    } else if (resolved.source === 'persisted') {
      stateManager.addLog(
        'info',
        'talktome-bridge',
        `Using persisted talktome bridge id ${bridgeId}`,
      );
    }
  } catch (error) {
    const message = `Talktome bridge id resolution failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    stateManager.setTalktomeBridgeGlobalStatus({
      enabled: true,
      phase: 'failed',
      baresipConnected: stateManager.getBaresipConnected(),
      serverReachable: false,
      lastError: message,
      updatedAt: Date.now(),
    });
    stateManager.addLog('error', 'talktome-bridge', message);
    return;
  }

  try {
    const config = useRuntimeConfig();
    const connection = getBaresipConnection(
      config.baresipHost,
      parseInt(config.baresipPort as string, 10),
    );
    const runtime = new TalktomeBridgeRuntime({
      connection,
      baseUrl: environment.baseUrl,
      bridgeId,
      token: environment.token,
      mediaAnnounceIp: environment.mediaAnnounceIp,
      configPath: environment.configPath,
      bridgeName: environment.bridgeName,
      authMode: environment.authMode,
      autoProvisionEndpoints: environment.autoProvisionEndpoints,
      commandTimeoutMs: environment.commandTimeoutMs,
      testedVersion: environment.testedVersion,
      serverVersionOverride: environment.serverVersionOverride || undefined,
    });
    setTalktomeBridgeRuntime(runtime);
    void runtime.start();

    nitroApp.hooks.hook('close', async () => {
      await runtime.stop();
      setTalktomeBridgeRuntime(undefined);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stateManager.setTalktomeBridgeGlobalStatus({
      enabled: true,
      phase: 'failed',
      baresipConnected: stateManager.getBaresipConnected(),
      serverReachable: false,
      lastError: message,
      updatedAt: Date.now(),
    });
    stateManager.addLog('error', 'talktome-bridge', message);
  }
});
