import {
  createHardFilter,
  type CountingHardFilter,
  type HardFilterState,
  type Post,
} from "@nmc/core";

/**
 * The worker's collection-session counter: distinct organic posts
 * (no ads, no repeats across overlapping responses), via one
 * session-long hard filter. MV3 restarts the service worker at will, so
 * the filter state lives in `chrome.storage.session` (memory-only,
 * cleared with the browser session) and is resumed on the next message.
 * A session ends when developer capture is toggled — `reset()`.
 */

/** The subset of `chrome.storage.session` this needs (fakeable in tests). */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const STATE_KEY = "nmc-capture-session";

interface StoredState {
  filter: HardFilterState;
  /** The target notification already fired for the current crossing. */
  notified: boolean;
}

interface LiveState {
  filter: CountingHardFilter;
  notified: boolean;
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
  #live: LiveState | null = null;
  /** Serialises read-modify-write; capture messages arrive concurrently. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(area: SessionArea) {
    this.#area = area;
  }

  /** Feeds one response's posts; resolves to distinct organic posts so far. */
  countPosts(posts: readonly Post[]): Promise<number> {
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

  /** Starts a new session: forgets every seen post and the notification. */
  reset(): Promise<void> {
    return this.#enqueue(async () => {
      this.#live = { filter: createHardFilter(), notified: false };
      await this.#area.remove(STATE_KEY);
    });
  }

  async #load(): Promise<LiveState> {
    if (this.#live) return this.#live;
    const stored = (await this.#area.get(STATE_KEY))[STATE_KEY];
    this.#live = isStoredState(stored)
      ? { filter: createHardFilter(stored.filter), notified: stored.notified }
      : { filter: createHardFilter(), notified: false };
    return this.#live;
  }

  async #save(live: LiveState): Promise<void> {
    const state: StoredState = { filter: live.filter.snapshot(), notified: live.notified };
    await this.#area.set({ [STATE_KEY]: state });
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
