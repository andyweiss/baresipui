import { normalizeAccountUri } from '../talktome-bridge-config';

const accountOperations = new Map<string, Promise<void>>();

/**
 * Serializes disruptive mapping mutations with baresip call lifecycle work for
 * one account. Callers must not acquire the same account lock recursively.
 */
export async function withTalktomeAccountLifecycleLock<T>(
  accountUri: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeAccountUri(accountUri);
  const previous = accountOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn, () => turn);
  accountOperations.set(key, queued);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (accountOperations.get(key) === queued) {
      accountOperations.delete(key);
    }
  }
}
