/**
 * Simple async mutex for TON wallet transactions.
 * Ensures the seqno read → sendTransfer sequence is atomic,
 * preventing two concurrent calls from getting the same seqno.
 */
let pending: Promise<void> = Promise.resolve();

const TX_LOCK_TIMEOUT_MS = 60_000;

export function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = () => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error("TON tx-lock timeout (60s)")),
        TX_LOCK_TIMEOUT_MS
      );
    });
    return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timerId));
  };
  const execute = pending.then(guarded, guarded);
  pending = execute.then(
    () => {},
    () => {}
  );
  return execute;
}
