/**
 * The Settings window saves as the user edits (no Save button), so a
 * change typed a moment before closing may still wait in the page. The
 * window's close is held until the page has saved it; an app quit is
 * held the same way and then goes on.
 */

export const SETTINGS_FLUSH_TIMEOUT_MS = 2_000;

export interface FlushChannel {
  /** Asks the page to save what waits. */
  request(): void;
  /** Calls `listener` when the page says it is done; returns the unsubscribe. */
  onDone(listener: () => void): () => void;
}

/** Resolves once the page saved what waited, or after `timeoutMs` (a page that cannot answer). */
export function requestFlush(
  channel: FlushChannel,
  timeoutMs: number = SETTINGS_FLUSH_TIMEOUT_MS,
): Promise<"flushed" | "timed-out"> {
  return new Promise((resolve) => {
    const finish = (outcome: "flushed" | "timed-out"): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timed-out"), timeoutMs);
    const unsubscribe = channel.onDone(() => finish("flushed"));
    channel.request();
  });
}

/**
 * Holds a window's first close while `flush` runs, then closes it for
 * real (`close`) and runs what waited for it (a held app quit).
 */
export class FlushBeforeClose {
  readonly #flush: () => Promise<unknown>;
  readonly #close: () => void;
  #state: "open" | "flushing" | "flushed" = "open";
  #after: (() => void)[] = [];

  constructor(flush: () => Promise<unknown>, close: () => void) {
    this.#flush = flush;
    this.#close = close;
  }

  get flushed(): boolean {
    return this.#state === "flushed";
  }

  /** A close (or quit) of the window: held, unless the page already saved. */
  hold(event: { preventDefault(): void }, then?: () => void): void {
    if (this.#state === "flushed") return;
    event.preventDefault();
    if (then) this.#after.push(then);
    if (this.#state === "flushing") return;
    this.#state = "flushing";
    void this.#flush()
      .catch(() => undefined)
      .then(() => {
        this.#state = "flushed";
        this.#close();
        for (const next of this.#after.splice(0)) next();
      });
  }
}
