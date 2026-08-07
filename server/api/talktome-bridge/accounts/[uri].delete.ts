import { withAccountAudioTransaction } from '../../../services/accounts-file';
import {
  getTalktomeBridgeConfigManager,
  normalizeAccountUri,
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

  const manager = getTalktomeBridgeConfigManager(
    environment.configPath,
  );
  await manager.load();

  let requiresRestart = false;
  await withTalktomeAccountLifecycleLock(accountUri, () =>
    withTalktomeMappingJournal(
      manager,
      environment.accountsConfigPath,
      async (journal) => {
        await withAccountAudioTransaction(
          environment.accountsConfigPath,
          async (transaction) => {
            const mapping = manager.getAccount(accountUri);
            if (!mapping) {
              throw createError({
                statusCode: 404,
                message: 'Talktome mapping not found',
              });
            }
            const account = transaction.getAccountAudioDevices(accountUri);
            const audioSource =
              mapping.previousAudioSource || environment.defaultAudioSource;
            const audioPlayer =
              mapping.previousAudioPlayer || environment.defaultAudioPlayer;
            requiresRestart = Boolean(
              account &&
                (account.audioSource !== audioSource ||
                  account.audioPlayer !== audioPlayer),
            );
            assertNoActiveCallConflict(
              accountUri,
              mapping.enabled || requiresRestart,
            );
            if (account) {
              transaction.setAccountAudioDevices(accountUri, {
                audioSource: audioSource || null,
                audioPlayer: audioPlayer || null,
              });
            }
            assertNoActiveCallConflict(
              accountUri,
              mapping.enabled || requiresRestart,
            );
            await journal.prepare({
              operation: 'delete',
              accountUri,
              previousMapping: mapping,
              expectedMapping: null,
              previousAudio: account
                ? {
                    audioSource: account.audioSource,
                    audioPlayer: account.audioPlayer,
                    audioSourcePresent: account.audioSourcePresent,
                    audioPlayerPresent: account.audioPlayerPresent,
                  }
                : null,
              expectedAudio: account
                ? {
                    audioSource,
                    audioPlayer,
                    audioSourcePresent: Boolean(audioSource),
                    audioPlayerPresent: Boolean(audioPlayer),
                  }
                : null,
            });
            await transaction.commit();
            assertNoActiveCallConflict(
              accountUri,
              mapping.enabled || requiresRestart,
            );
            await manager.removeAccount(accountUri);
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
        'Talktome mapping or audio devices cannot be removed while the account has active calls',
    });
  }
}
