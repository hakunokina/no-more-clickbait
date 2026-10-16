import {
  createHardFilter,
  type CountingHardFilter,
  type FeedItem,
  type HardFilterState,
} from "@nmc/core";

/**
 * The worker's collection-session counter: distinct organic posts
 * (no ads, no repeats across overlapping responses), via one
 * session-long hard filter. MV3 restarts the service worker at will, so
 * the filter state lives in `chrome.storage.session` (memory-only,
 * cleared with the browser session) and is resumed on the next message.
 * A session ends when developer capture is toggled — `reset()`.
 *
 * One session per scrolled feed (X, Instagram: each its own storage
 * key). A feed whose part of a collection ended while another feed is
 * still collecting is `close`d: its later posts stay out of the
 * collection until the next session.
 */

/** The subset of `chrome.storage.session` this needs (fakeable in tests). */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The X session's key (the first, kept as it was). */
export const X_SESSION_KEY = "nmc-capture-session";
export const INSTAGRAM_SESSION_KEY = "nmc-capture-session-instagram";

interface StoredState {
  filter: HardFilterState;
  /** The target notification already fired for the current crossing. */
  notified: boolean;
  /** Why this feed's part of the collection ended (absent: still collecting). */
  closed?: string;
}

interface LiveState {
  filter: CountingHardFilter;
  notified: boolean;
  closed: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Every counter the filter increments must be present, or `+= 1` yields NaN. */
function isHardFilterStats(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { dropped, flagged } = value;
  return (
    isCount(value["seen"]) &&
    isCount(value["kept"]) &&
    isRecord(dropped) &&
    isCount(dropped["promoted"]) &&
    isCount(dropped["duplicate"]) &&
    isCount(dropped["duplicate-repost"]) &&
    isRecord(flagged) &&
    isCount(flagged["mediaOnly"])
  );
}

function isStoredState(value: unknown): value is StoredState {
  if (!isRecord(value) || typeof value["notified"] !== "boolean") return false;
  if (value["closed"] !== undefined && typeof value["closed"] !== "string") return false;
  const filter = value["filter"];
  return (
    isRecord(filter) &&
    Array.isArray(filter["seen"]) &&
    filter["seen"].every(
      (entry: unknown) =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "boolean",
    ) &&
    isHardFilterStats(filter["stats"])
  );
}

export class CaptureSession {
  readonly #area: SessionArea;
  readonly #key: string;
  #live: LiveState | null = null;
  /** Serialises read-modify-write; capture messages arrive concurrently. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(area: SessionArea, key: string = X_SESSION_KEY) {
    this.#area = area;
    this.#key = key;
  }

  /** Feeds one response's posts; resolves to distinct organic posts so far. */
  countPosts(posts: readonly FeedItem[]): Promise<number> {
    return this.#enqueue(async () => {
      const live = await this.#load();
      for (const post of posts) live.filter.keep(post);
      await this.#save(live);
      return live.filter.stats.kept;
    });
  }

  /** Distinct organic posts so far, after every count already queued. */
  uniqueCount(): Promise<number> {
    return this.#enqueue(async () => (await this.#load()).filter.stats.kept);
  }

  /**
   * True exactly once each time `count` climbs to `target`; a count
   * back under the target (e.g. the host started a new capture
   * session) re-arms it.
   */
  reachedTarget(count: number, target: number): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = await this.#load();
      const reached = count >= target;
      const fire = reached && !live.notified;
      if (live.notified !== reached) {
        live.notified = reached;
        await this.#save(live);
      }
      return fire;
    });
  }

  /** Ends this feed's part of the collection (the first reason stays). */
  close(reason: string): Promise<void> {
    return this.#enqueue(async () => {
      const live = await this.#load();
      if (live.closed !== null) return;
      live.closed = reason;
      await this.#save(live);
    });
  }

  /** Why this feed's part ended, or null while it is still collecting. */
  closedReason(): Promise<string | null> {
    return this.#enqueue(async () => (await this.#load()).closed);
  }

  /** Starts a new session: forgets every seen post, the notification and the close. */
  reset(): Promise<void> {
    return this.#enqueue(async () => {
      this.#live = { filter: createHardFilter(), notified: false, closed: null };
      await this.#area.remove(this.#key);
    });
  }

  async #load(): Promise<LiveState> {
    if (this.#live) return this.#live;
    const stored = (await this.#area.get(this.#key))[this.#key];
    this.#live = isStoredState(stored)
      ? {
          filter: createHardFilter(stored.filter),
          notified: stored.notified,
          closed: stored.closed ?? null,
        }
      : { filter: createHardFilter(), notified: false, closed: null };
    return this.#live;
  }

  async #save(live: LiveState): Promise<void> {
    const state: StoredState = {
      filter: live.filter.snapshot(),
      notified: live.notified,
      ...(live.closed === null ? {} : { closed: live.closed }),
    };
    await this.#area.set({ [this.#key]: state });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
