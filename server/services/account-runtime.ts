import { BaresipCommandError, type BaresipConnection } from './baresip-connection';
import type { AccountFileEntry } from '~/types';
import { formatAccountLine } from './accounts-file';

// baresip's `uadel <aor>` removes only ONE matching UA per call (uag_find_aor returns the
// first match). Repeated add/enable cycles can leave several live UAs registered under the
// same AOR, so purge in a loop until baresip reports none left, instead of a single call.
const MAX_PURGE_ATTEMPTS = 25;

export async function purgeLiveAccount(connection: BaresipConnection, uri: string): Promise<void> {
  for (let i = 0; i < MAX_PURGE_ATTEMPTS; i++) {
    try {
      await connection.executeCommand('uadel', uri);
    } catch (err) {
      // A response from baresip (even a failing one, e.g. "not found") means the AOR is
      // genuinely gone - stop. Anything without a response (disconnected, timeout, write
      // failure) means we never actually talked to baresip, so surface that to the caller.
      if (err instanceof BaresipCommandError && err.response) return;
      throw err;
    }
  }
}

/** Ensures exactly one live UA exists for this account entry: purge any duplicates/old URI, then recreate if enabled. */
export async function syncLiveAccount(
  connection: BaresipConnection,
  entry: AccountFileEntry,
  previousUri?: string,
): Promise<void> {
  if (previousUri) {
    await purgeLiveAccount(connection, previousUri);
  }
  if (!previousUri || previousUri !== entry.uri) {
    await purgeLiveAccount(connection, entry.uri);
  }
  if (entry.enabled) {
    await connection.executeCommand('uanew', formatAccountLine(entry));
  }
}
