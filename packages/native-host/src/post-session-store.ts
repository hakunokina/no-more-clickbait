import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  FeedBatchSchema,
  PostBatchSchema,
  type CollectionMetrics,
  type FeedBatch,
  type FeedItem,
  type Post,
  type PostBatch,
} from "@nmc/core";
import { desktopDataDir, SessionIdSchema } from "./desktop-link.js";

/**
 * Collection sessions on disk — the data plane between the host and the
 * desktop app. Every validated post batch lands in
 * `%LOCALAPPDATA%\NoMoreClickbait\sessions\<id>\batches\NNNN.json`
 * whether or not the desktop app runs; a finished collection writes
 * `complete.json` (counts only) and the desktop app, live or at its next
 * start, runs the pipeline over it and writes `processed.json`.
 *
 * One host process == one session (the extension reconnects to start a
 * new one). Batches hold feed content — personal data that stays in the
 * user's profile and is never logged. At most SESSION_RETENTION
 * sessions are kept (see pruneSessions for which go first).
 */

export const SESSION_RETENTION = 10;

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "sessions");
}

export const SessionCompletionSchema = z.object({
  mode: z.enum(["A", "B"]),
  reason: z.string().max(64),
  uniquePostCount: z.number().int().nonnegative(),
  responseCount: z.number().int().nonnegative(),
  /** Distinct posts the collection was working towards (absent in older sessions). */
  target: z.number().int().min(1).optional(),
  completedAt: z.string().datetime(),
});
export type SessionCompletion = z.infer<typeof SessionCompletionSchema>;

export const SessionProcessedSchema = z.object({
  /** `error`: the run failed; only the user's "Try again" runs it again. */
  status: z.enum(["done", "cancelled", "superseded", "error"]),
  processedAt: z.string().datetime(),
  /** Why the run failed (status `error`); fixed messages, never feed content. */
  error: z
    .object({
      kind: z.string().max(64),
      message: z.string().max(500),
    })
    .optional(),
});
export type SessionProcessed = z.infer<typeof SessionProcessedSchema>;

/**
 * `session.json`: what the host knows about a session while it runs
 * (open for more fields). Written once a Mode B run reports, so a
 * session that never completed can still be told apart from the user's
 * own scrolling.
 */
export const SessionInfoSchema = z.object({
  mode: z.enum(["A", "B"]),
  /** When the host learned the mode. */
  startedAt: z.string().datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

function newSessionId(nowIso: string): string {
  const stamp = nowIso.replaceAll(":", "-").replaceAll(".", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const BATCH_FILE = /^\d{4,}\.json$/;
/** Non-X (`feed-batch`) batches: the same folder, never mixed into the X counts. */
const FEED_BATCH_FILE = /^f\d{4,}\.json$/;

async function countBatches(dir: string): Promise<number> {
  try {
    return (await readdir(join(dir, "batches"))).filter((name) => BATCH_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

/**
 * Trims the session folders down to `keep`. Never deleted: `protect`
 * (the calling host's own session), the newest `done` session (the
 * timeline the user may be reading), the newest complete unprocessed
 * session (the desktop app is running it or it waits for the user's
 * go) and the newest failed one ("Try again"). Superseded, cancelled
 * and empty sessions go first, then the rest oldest first (ids sort
 * by time).
 */
export async function pruneSessions(
  root: string,
  keep: number = SESSION_RETENTION,
  protect?: string,
): Promise<void> {
  const sessions = await listSessions(root);
  const excess = sessions.length - keep;
  if (excess <= 0) return;
  const newest = (match: (session: SessionListing) => boolean): string | undefined =>
    [...sessions].reverse().find(match)?.id;
  const kept = new Set(
    [
      protect,
      newest((session) => session.processed?.status === "done"),
      newest((session) => session.complete && session.processed === null),
      newest((session) => session.processed?.status === "error"),
    ].filter((id): id is string => id !== undefined),
  );
  const discardable: SessionListing[] = [];
  const rest: SessionListing[] = [];
  for (const session of sessions) {
    if (kept.has(session.id)) continue;
    const status = session.processed?.status;
    const discarded =
      status === "superseded" || status === "cancelled" || session.batchCount === 0;
    (discarded ? discardable : rest).push(session);
  }
  for (const session of [...discardable, ...rest].slice(0, excess)) {
    await rm(session.dir, { recursive: true, force: true });
  }
}

export class PostSessionStore {
  readonly #root: string;
  readonly #now: () => string;
  readonly #keep: number;
  #sessionId: string | null = null;
  #batchCount = 0;
  #completed = false;
  /** Mode to record in session.json; written once the folder exists. */
  #info: SessionInfo | null = null;
  #infoWritten = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    root: string = sessionsRoot(),
    now: () => string = () => new Date().toISOString(),
    keep: number = SESSION_RETENTION,
  ) {
    this.#root = root;
    this.#now = now;
    this.#keep = keep;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Stores one batch. Batches after `complete` are refused (new session needed). */
  async addBatch(batch: PostBatch): Promise<boolean> {
    return this.#enqueue(async () => {
      if (this.#completed) return false;
      if (!this.#sessionId) {
        this.#sessionId = newSessionId(this.#now());
        await mkdir(join(this.#root, this.#sessionId, "batches"), { recursive: true });
        await pruneSessions(this.#root, this.#keep, this.#sessionId);
      }
      // Before the batch: a session.json write that failed earlier is
      // retried here, so the Mode B tag is not lost for this session.
      await this.#writeInfo();
      this.#batchCount += 1;
      const name = `${String(this.#batchCount).padStart(4, "0")}.json`;
      await writeJsonAtomic(join(this.#root, this.#sessionId, "batches", name), batch);
      return true;
    });
  }

  /**
   * Stores non-X items (custom sites) next to the X batches
   * (`fNNNN.json`). Never part of the X counts; refused after
   * `complete` like X batches. Returns the stored item count.
   */
  async addFeedBatch(batch: FeedBatch): Promise<number> {
    return this.#enqueue(async () => {
      if (this.#completed) return 0;
      if (!this.#sessionId) {
        this.#sessionId = newSessionId(this.#now());
        await mkdir(join(this.#root, this.#sessionId, "batches"), { recursive: true });
        await pruneSessions(this.#root, this.#keep, this.#sessionId);
      }
      this.#batchCount += 1;
      const name = `f${String(this.#batchCount).padStart(4, "0")}.json`;
      await writeJsonAtomic(
        join(this.#root, this.#sessionId, "batches", name),
        FeedBatchSchema.parse(batch),
      );
      return batch.items.length;
    });
  }

  /**
   * Marks the session complete; returns its id, or null when nothing
   * was stored (a collection that gathered no posts has no folder).
   */
  async complete(completion: Omit<SessionCompletion, "completedAt">): Promise<string | null> {
    return this.#enqueue(async () => {
      this.#completed = true;
      if (!this.#sessionId) return null;
      const record: SessionCompletion = { ...completion, completedAt: this.#now() };
      await writeJsonAtomic(join(this.#root, this.#sessionId, "complete.json"), record);
      return this.#sessionId;
    });
  }

  /**
   * Records the session's collection mode in session.json (the only
   * writer). Before the first batch there is no folder yet: it is
   * written with it. The first mode recorded stays.
   */
  async markMode(mode: SessionInfo["mode"]): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#completed) return;
      if (!this.#info) this.#info = { mode, startedAt: this.#now() };
      // Written every time until it sticks: a failed write is retried by
      // the next mark or batch.
      await this.#writeInfo();
    });
  }

  async #writeInfo(): Promise<void> {
    if (!this.#info || !this.#sessionId || this.#infoWritten) return;
    // Flag only after a successful write: a failed write must be retried
    // by the next batch, or this Mode B session would never be counted.
    await writeJsonAtomic(join(this.#root, this.#sessionId, "session.json"), this.#info);
    this.#infoWritten = true;
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

export interface SessionListing {
  id: string;
  dir: string;
  complete: boolean;
  /** How the collection ended (mode, counts), when complete. */
  completion: SessionCompletion | null;
  processed: SessionProcessed | null;
  /** session.json, when the host recorded the mode (Mode B runs). */
  info: SessionInfo | null;
  /** Stored post batches. */
  batchCount: number;
}

/** When a session's first batch was stored (its id is that time). */
export function sessionStartedAt(id: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(id);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null;
}

/** Sessions, oldest first. */
export async function listSessions(root: string = sessionsRoot()): Promise<SessionListing[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const ids = names.filter((name) => SessionIdSchema.safeParse(name).success).sort();
  return Promise.all(
    ids.map(async (id) => {
      const dir = join(root, id);
      const complete = SessionCompletionSchema.safeParse(
        await readJson(join(dir, "complete.json")),
      );
      const processed = SessionProcessedSchema.safeParse(
        await readJson(join(dir, "processed.json")),
      );
      const info = SessionInfoSchema.safeParse(await readJson(join(dir, "session.json")));
      return {
        id,
        dir,
        complete: complete.success,
        completion: complete.success ? complete.data : null,
        processed: processed.success ? processed.data : null,
        info: info.success ? info.data : null,
        batchCount: await countBatches(dir),
      };
    }),
  );
}

export async function markSessionProcessed(
  dir: string,
  status: SessionProcessed["status"],
  now: () => string = () => new Date().toISOString(),
  error?: SessionProcessed["error"],
): Promise<void> {
  const record: SessionProcessed = { status, processedAt: now(), ...(error ? { error } : {}) };
  await writeJsonAtomic(join(dir, "processed.json"), record);
}

export interface LoadedSession {
  id: string;
  dir: string;
  /** Every stored post in capture order (repeats/ads included: the hard filter drops them). */
  posts: Post[];
  batchCount: number;
  /** Batches that failed validation and were skipped. */
  invalidBatchCount: number;
  /** Non-X items in capture order (`feed-batch`, outside the X counts). */
  feedItems: FeedItem[];
  /** Stored `feed-batch` batches. */
  feedBatchCount: number;
  completion: SessionCompletion | null;
  collection?: CollectionMetrics;
}

/** Reads a session back. Disk content is re-validated: it is feed-derived. */
export async function loadSession(root: string, id: string): Promise<LoadedSession> {
  const sessionId = SessionIdSchema.parse(id);
  const dir = join(root, sessionId);
  const batchDir = join(dir, "batches");
  const names = (await readdir(batchDir)).filter((name) => BATCH_FILE.test(name)).sort();
  const feedNames = (await readdir(batchDir))
    .filter((name) => FEED_BATCH_FILE.test(name))
    .sort();
  const posts: Post[] = [];
  let invalidBatchCount = 0;
  let xInvalid = 0;
  let first: string | undefined;
  let last: string | undefined;
  for (const name of names) {
    const batch = PostBatchSchema.safeParse(await readJson(join(batchDir, name)));
    if (!batch.success) {
      invalidBatchCount += 1;
      xInvalid += 1;
      continue;
    }
    posts.push(...batch.data.posts);
    const at = batch.data.capturedAt;
    if (!first || at < first) first = at;
    if (!last || at > last) last = at;
  }
  const feedItems: FeedItem[] = [];
  let feedBatchCount = 0;
  for (const name of feedNames) {
    const batch = FeedBatchSchema.safeParse(await readJson(join(batchDir, name)));
    if (!batch.success) {
      invalidBatchCount += 1;
      continue;
    }
    feedBatchCount += 1;
    feedItems.push(...batch.data.items);
  }
  const completion = SessionCompletionSchema.safeParse(
    await readJson(join(dir, "complete.json")),
  );
  return {
    id: sessionId,
    dir,
    posts,
    batchCount: names.length - xInvalid,
    invalidBatchCount,
    feedItems,
    feedBatchCount,
    completion: completion.success ? completion.data : null,
    ...(first && last
      ? {
          collection: {
            firstCapturedAt: first,
            lastCapturedAt: last,
            postCount: posts.length,
            ...(completion.success
              ? {
                  uniquePostCount: completion.data.uniquePostCount,
                  responseCount: completion.data.responseCount,
                }
              : {}),
          },
        }
      : {}),
  };
}
