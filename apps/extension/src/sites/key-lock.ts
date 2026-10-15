/**
 * Runs read-modify-write steps on one storage key one at a time, in call
 * order, within this JS context (the worker, or one Options page). Per-site
 * keys keep different sites apart; this keeps two writers of the same site
 * in the same context (a collect finishing while a "more" capture lands)
 * from overwriting each other. A failed step does not block the next.
 */

const tails = new Map<string, Promise<void>>();

export function withKeyLock<T>(key: string, step: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(step);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
