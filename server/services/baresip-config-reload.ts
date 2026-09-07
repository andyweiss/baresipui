import { getBaresipConnection } from './baresip-connection';
import { stateManager } from './state-manager';

export interface ConfigReloadResult {
  reloaded: boolean;
  error?: string;
}

/**
 * Asks the running baresip to re-read its config file and broadcasts whether
 * the daemon is now in sync with the file on disk. A failed reload leaves the
 * file as written and flags the UI, since the file stays the source of truth.
 */
export async function reloadBaresipConfig(
  host: string,
  port: number,
): Promise<ConfigReloadResult> {
  try {
    const connection = getBaresipConnection(host, port);
    await connection.executeCommand('conf_reload');
    stateManager.broadcast({ type: 'configPendingRestart', pending: false });
    return { reloaded: true };
  } catch (err: any) {
    stateManager.broadcast({ type: 'configPendingRestart', pending: true });
    return { reloaded: false, error: err?.message || 'Reload failed' };
  }
}
