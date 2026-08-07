import type {
  TalktomeAccountMapping,
  TalktomeAccountMappingInput,
} from '~/types';
import { withAccountAudioTransaction } from '../../../services/accounts-file';
import {
  getTalktomeBridgeConfigManager,
  isFeedMapping,
  normalizeAccountUri,
  TalktomeConfigValidationError,
  validateTalktomeBridgeConfig,
} from '../../../services/talktome-bridge-config';
import { readTalktomeBridgeEnvironment } from '../../../services/talktome/env';
import { getTalktomeBridgeRuntime } from '../../../services/talktome/runtime';
import { withTalktomeAccountLifecycleLock } from '../../../services/talktome/account-lifecycle-lock';
import { withTalktomeMappingJournal } from '../../../services/talktome/transaction-journal';
import { stateManager } from '../../../services/state-manager';

export default defineEventHandler(async (event) => {
  const environment = readTalktomeBridgeEnvironment();
  if (!environment.enabled) {
    throw createError({ statusCode: 404, message: 'Talktome bridge is disabled' });
  }

  let accountUri: string;
  try {
    accountUri = normalizeAccountUri(
      decodeURIComponent(getRouterParam(event, 'uri') || ''),
    );
  } catch (error) {
    throw createError({
      statusCode: 400,
      message: error instanceof Error ? error.message : 'Invalid account URI',
    });
  }

  const body = await readBody(event);
  if (!isRecord(body)) {
    throw createError({ statusCode: 400, message: 'Mapping body must be an object' });
  }

  const manager = getTalktomeBridgeConfigManager(
    environment.configPath,
  );
  await manager.load();

  let mapping!: TalktomeAccountMapping;
  let requiresRestart = false;
  await withTalktomeAccountLifecycleLock(accountUri, () =>
    withTalktomeMappingJournal(
      manager,
      environment.accountsConfigPath,
      async (journal) => {
        await withAccountAudioTransaction(
          environment.accountsConfigPath,
          async (transaction) => {
            const account = transaction.getAccountAudioDevices(accountUri);
            if (!account) {
              throw createError({ statusCode: 404, message: 'SIP account not found' });
            }
            const currentMapping = manager.getAccount(accountUri);
            const previousAudioSource =
              currentMapping?.previousAudioSource ??
              capturePreviousDevice(
                account.audioSource,
                environment.defaultAudioSource,
              );
            const previousAudioPlayer =
              currentMapping?.previousAudioPlayer ??
              capturePreviousDevice(
                account.audioPlayer,
                environment.defaultAudioPlayer,
              );

            try {
              const currentConfig = manager.getConfig();
              mapping = validateTalktomeBridgeConfig({
                accounts: {
                  ...currentConfig.accounts,
                  [accountUri]: {
                    ...body,
                    previousAudioSource,
                    previousAudioPlayer,
                  },
                },
              }).accounts[accountUri];
            } catch (error) {
              if (error instanceof TalktomeConfigValidationError) {
                throw createError({
                  statusCode: 400,
                  message: 'Invalid talktome account mapping',
                  data: { issues: error.issues },
                });
              }
              throw error;
            }

            const server = getTalktomeBridgeRuntime()?.getPublicServerConfig();
            if (!isFeedMapping(mapping)) {
              const serverPort = server?.userPorts.find(
                (port) => port.userId === mapping.talktomeUserId,
              );
              if (
                serverPort &&
                !serverPort.triggerTargets.some(
                  (target) =>
                    target.type === mapping.target.type &&
                    target.id === mapping.target.id,
                )
              ) {
                throw createError({
                  statusCode: 400,
                  message: 'Target is not allowed for this talktome user endpoint',
                });
              }
            }

            const nextSource = mapping.enabled
              ? `mediasoup,${mapping.key}`
              : previousAudioSource || environment.defaultAudioSource;
            const nextPlayer = mapping.enabled
              ? `mediasoup,${mapping.key}`
              : previousAudioPlayer || environment.defaultAudioPlayer;
            requiresRestart =
              account.audioSource !== nextSource ||
              account.audioPlayer !== nextPlayer;
            const mappingRestart =
              Boolean(currentMapping?.enabled || mapping.enabled) &&
              mappingAffectsRuntime(currentMapping, mapping);
            assertNoActiveCallConflict(
              accountUri,
              requiresRestart || mappingRestart,
            );

            transaction.setAccountAudioDevices(accountUri, {
              audioSource: nextSource || null,
              audioPlayer: nextPlayer || null,
            });
            assertNoActiveCallConflict(
              accountUri,
              requiresRestart || mappingRestart,
            );
            await journal.prepare({
              operation: 'put',
              accountUri,
              previousMapping: currentMapping ?? null,
              expectedMapping: mapping,
              previousAudio: {
                audioSource: account.audioSource,
                audioPlayer: account.audioPlayer,
                audioSourcePresent: account.audioSourcePresent,
                audioPlayerPresent: account.audioPlayerPresent,
              },
              expectedAudio: {
                audioSource: nextSource,
                audioPlayer: nextPlayer,
                audioSourcePresent: Boolean(nextSource),
                audioPlayerPresent: Boolean(nextPlayer),
              },
            });
            await transaction.commit();
            assertNoActiveCallConflict(
              accountUri,
              requiresRestart || mappingRestart,
            );
            await manager.setAccount(
              accountUri,
              mapping as TalktomeAccountMappingInput,
            );
          },
        );
      },
    ),
  );

  let runtimeError: string | undefined;
  const runtime = getTalktomeBridgeRuntime();
  if (!runtime) {
    runtimeError = 'Talktome bridge runtime is not initialized';
  } else {
    try {
      await runtime.refreshAccount(accountUri);
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    success: true,
    accountUri,
    mapping: manager.getAccount(accountUri),
    requiresRestart,
    runtimeRefreshed: !runtimeError,
    ...(runtimeError ? { runtimeError } : {}),
  };
});

function assertNoActiveCallConflict(
  accountUri: string,
  disruptive: boolean,
): void {
  if (
    disruptive &&
    (stateManager
      .getCallsByAccount(accountUri)
      .some((call) => call.state !== 'Closing') ||
      Boolean(
        stateManager.getTalktomeBridgeStatus(accountUri)?.activeCallIds.length,
      ))
  ) {
    throw createError({
      statusCode: 409,
      message:
        'Talktome mapping or audio devices cannot change while the account has active calls',
    });
  }
}

function mappingAffectsRuntime(
  previous: TalktomeAccountMapping | undefined,
  next: TalktomeAccountMapping,
): boolean {
  if (!previous) return next.enabled;
  return (
    previous.enabled !== next.enabled ||
    previous.key !== next.key ||
    previous.endpointKind !== next.endpointKind ||
    previous.talktomeUserId !== next.talktomeUserId ||
    previous.talktomeFeedId !== next.talktomeFeedId ||
    previous.target?.type !== next.target?.type ||
    previous.target?.id !== next.target?.id ||
    previous.ptt.mode !== next.ptt.mode ||
    previous.ptt.thresholdDb !== next.ptt.thresholdDb ||
    previous.ptt.holdMs !== next.ptt.holdMs ||
    previous.ptt.gpi !== next.ptt.gpi ||
    previous.mixLocalCallers !== next.mixLocalCallers ||
    previous.bitrateBps !== next.bitrateBps
  );
}

function capturePreviousDevice(value: string, fallback: string): string {
  return value.startsWith('mediasoup,') ? fallback : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
