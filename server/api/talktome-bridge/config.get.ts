import type { TalktomeBridgeConfigResponse } from '~/types';
import { stateManager } from '../../services/state-manager';
import { getTalktomeBridgeConfigManager } from '../../services/talktome-bridge-config';
import { readTalktomeBridgeEnvironment } from '../../services/talktome/env';
import { getTalktomeBridgeRuntime } from '../../services/talktome/runtime';

export default defineEventHandler(async (): Promise<TalktomeBridgeConfigResponse> => {
  const environment = readTalktomeBridgeEnvironment();
  if (!environment.enabled) {
    return {
      enabled: false,
      globalStatus: {
        enabled: false,
        phase: 'disabled',
        baresipConnected: stateManager.getBaresipConnected(),
        serverReachable: false,
        updatedAt: stateManager.getTalktomeBridgeGlobalStatus().updatedAt,
      },
      mappings: {},
      statuses: [],
      server: null,
    };
  }

  const manager = getTalktomeBridgeConfigManager(
    environment.configPath,
  );
  await manager.load();
  const runtime = getTalktomeBridgeRuntime();
  const globalStatus = stateManager.getTalktomeBridgeGlobalStatus();
  const server = globalStatus.serverReachable
    ? (await runtime?.refreshServerConfig()) ??
      runtime?.getPublicServerConfig() ??
      null
    : null;

  return {
    enabled: true,
    globalStatus: stateManager.getTalktomeBridgeGlobalStatus(),
    mappings: manager.getConfig().accounts,
    statuses: stateManager.getTalktomeBridgeStatuses(),
    server,
  };
});
