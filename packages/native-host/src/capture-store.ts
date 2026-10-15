import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  countTimelineEntries,
  createHardFilter,
  parseHomeTimeline,
  type CaptureSource,
  type CaptureStats,
  type CollectionMetrics,
  type ModeBRunSummary,
  type OversizedCapture,
  type RawCapture,
} from "@nmc/core";

/**
 * Developer-capture storage. Raw HomeTimeline response bodies are
 * personal data: they are written OUTSIDE the repo —
 * `%LOCALAPPDATA%\nmc\captures\<session-time>\` by default, or under
 * `NMC_INBOX_DIR` when the user overrides it. One host process == one
 * capture session; `summary.json` next to the dumps holds only counts
 * and times (a CollectionMetrics), never content.
 *
 * Two post counts are kept: `postCount` is the rough per-response
 * `tweet-` entry tally (repeats across overlapping responses included),
 * `uniquePostCount` runs every parsed Post through one session-long
 * hard filter — distinct organic posts, the number the capture target
 * is measured against.
 *
 * A Mode B run gets its own host session (the extension reconnects at
 * run start), so its counts land next to its dumps as `modeBRun` — also
 * when the run captured nothing (e.g. not logged in).
 *
 * Other sources (Reddit) get their own store and folder,
 * `<session-time>-<source>\`, so their counts never mix with X's.
 * Reddit bodies are HTML fragments (or JSON), not GraphQL: the counts
 * come from `<shreddit-post>` opening tags — `uniquePostCount` is the
 * number of distinct post ids, `promotedCount` the `<shreddit-ad-post>`
 * tags — and `paths` lists which capture labels (URL paths, DOM
 * snapshots) arrived and what their bodies looked like.
 */

/** Per capture label: responses received, by sniffed body kind. */
export interface CapturePathCounts {
  responses: number;
  json: number;
  html: number;
  other: number;
}

export interface CaptureSummary extends CollectionMetrics {
  /** Last minus first capture time, for the "collection span" measurement. */
  collectionSpanMs: number;
  modeBRun?: ModeBRunSummary;
  /** Non-X sources only. */
  source?: CaptureSource;
  paths?: Record<string, CapturePathCounts>;
}

/** Distinct labels kept in `paths`; the rest are tallied under OTHER_PATHS. */
const MAX_PATHS = 200;
const OTHER_PATHS = "(other)";

type BodyKind = "json" | "html" | "other";

function bodyKindOf(bodyText: string): BodyKind {
  try {
    JSON.parse(bodyText);
    return "json";
  } catch {
    return bodyText.trimStart().startsWith("<") ? "html" : "other";
  }
}

const SHREDDIT_TAG = /<shreddit-(post|ad-post)(?=[\s/>])[^>]*>/g;
// Inside a JSON-encoded body the quotes arrive escaped (\").
const ID_ATTRIBUTE = /\sid=\\?"([^"\\]+)/;

/** Opening `<shreddit-post>` / `<shreddit-ad-post>` tags in a Reddit body. */
export function countShredditPosts(bodyText: string): {
  postIds: string[];
  postTags: number;
  adTags: number;
} {
  const postIds: string[] = [];
  let postTags = 0;
  let adTags = 0;
  for (const match of bodyText.matchAll(SHREDDIT_TAG)) {
    if (match[1] === "ad-post") {
      adTags += 1;
      continue;
    }
    postTags += 1;
    const id = ID_ATTRIBUTE.exec(match[0])?.[1];
    if (id) postIds.push(id);
  }
  return { postIds, postTags, adTags };
}

export function defaultCaptureRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["NMC_INBOX_DIR"];
  if (override) return override;
  const localAppData = env["LOCALAPPDATA"];
  return localAppData
    ? join(localAppData, "nmc", "captures")
    : join(homedir(), ".local", "share", "nmc", "captures");
}

function stampOf(iso: string): string {
  return iso.replaceAll(":", "-").replaceAll(".", "-");
}

function safeOperation(operation: string): string {
  return operation.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

export class CaptureStore {
  readonly #rootDir: string;
  readonly #now: () => string;
  readonly #source: CaptureSource;
  #sessionDir: string | null = null;
  #sequence = 0;
  #firstCapturedAt: string | null = null;
  #lastCapturedAt: string | null = null;
  #responseCount = 0;
  #postCount = 0;
  #promotedCount = 0;
  #oversizedCount = 0;
  readonly #uniqueFilter = createHardFilter();
  readonly #redditPostIds = new Set<string>();
  readonly #paths = new Map<string, CapturePathCounts>();
  #modeBRun: ModeBRunSummary | null = null;
  /** Serialises file writes; handler calls may arrive concurrently. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    rootDir: string = defaultCaptureRoot(),
    now: () => string = () => new Date().toISOString(),
    source: CaptureSource = "x",
  ) {
    this.#rootDir = rootDir;
    this.#now = now;
    this.#source = source;
  }

  get stats(): CaptureStats {
    return {
      responseCount: this.#responseCount,
      postCount: this.#postCount,
      uniquePostCount: this.#uniqueCount(),
      promotedCount: this.#promotedCount,
      oversizedCount: this.#oversizedCount,
    };
  }

  get sessionDir(): string | null {
    return this.#sessionDir;
  }

  summary(): CaptureSummary | null {
    if (!this.#firstCapturedAt || !this.#lastCapturedAt) return null;
    return {
      firstCapturedAt: this.#firstCapturedAt,
      lastCapturedAt: this.#lastCapturedAt,
      postCount: this.#postCount,
      uniquePostCount: this.#uniqueCount(),
      responseCount: this.#responseCount,
      promotedCount: this.#promotedCount,
      oversizedCount: this.#oversizedCount,
      collectionSpanMs: Date.parse(this.#lastCapturedAt) - Date.parse(this.#firstCapturedAt),
      ...(this.#modeBRun ? { modeBRun: this.#modeBRun } : {}),
      ...(this.#source === "x"
        ? {}
        : { source: this.#source, paths: Object.fromEntries(this.#paths) }),
    };
  }

  /** Stores one raw capture verbatim and returns its sequence number. */
  async store(capture: RawCapture): Promise<number> {
    return this.#enqueue(async () => {
      const dir = this.#ensureSession();
      await mkdir(dir, { recursive: true });
      this.#sequence += 1;
      const sequence = this.#sequence;
      const kind = this.#source === "x" ? "json" : bodyKindOf(capture.bodyText);
      const name = `${String(sequence).padStart(4, "0")}-${stampOf(capture.capturedAt)}-${safeOperation(capture.operation)}.${kind === "html" ? "html" : "json"}`;
      await writeFile(join(dir, name), capture.bodyText, "utf8");
      this.#markTime(capture.capturedAt);
      this.#responseCount += 1;
      if (this.#source !== "x") {
        this.#countOther(capture.operation, kind, capture.bodyText);
        await this.#writeSummary(dir);
        return sequence;
      }
      try {
        const payload = JSON.parse(capture.bodyText) as unknown;
        const counts = countTimelineEntries(payload);
        this.#postCount += counts.postCount;
        this.#promotedCount += counts.promotedCount;
        for (const post of parseHomeTimeline(payload)) this.#uniqueFilter.keep(post);
      } catch {
        // Not JSON: the raw dump is kept; it contributes no post count.
      }
      await this.#writeSummary(dir);
      return sequence;
    });
  }

  /** Records a refused oversized response (no body was ever received). */
  async recordOversized(capture: OversizedCapture): Promise<void> {
    await this.#enqueue(async () => {
      const dir = this.#ensureSession();
      await mkdir(dir, { recursive: true });
      this.#markTime(capture.capturedAt);
      this.#oversizedCount += 1;
      await this.#writeSummary(dir);
    });
  }

  /** Records a finished Mode B run (counts and times only). */
  async recordModeBRun(run: ModeBRunSummary): Promise<void> {
    await this.#enqueue(async () => {
      const dir = this.#ensureSession();
      await mkdir(dir, { recursive: true });
      this.#modeBRun = run;
      await this.#writeSummary(dir);
    });
  }

  #uniqueCount(): number {
    return this.#source === "x" ? this.#uniqueFilter.stats.kept : this.#redditPostIds.size;
  }

  #countOther(operation: string, kind: BodyKind, bodyText: string): void {
    const label =
      this.#paths.has(operation) || this.#paths.size < MAX_PATHS ? operation : OTHER_PATHS;
    const counts = this.#paths.get(label) ?? { responses: 0, json: 0, html: 0, other: 0 };
    counts.responses += 1;
    counts[kind] += 1;
    this.#paths.set(label, counts);
    if (this.#source !== "reddit") return;
    const { postIds, postTags, adTags } = countShredditPosts(bodyText);
    this.#postCount += postTags;
    this.#promotedCount += adTags;
    for (const id of postIds) this.#redditPostIds.add(id);
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #ensureSession(): string {
    if (!this.#sessionDir) {
      const suffix = this.#source === "x" ? "" : `-${this.#source}`;
      this.#sessionDir = join(this.#rootDir, `${stampOf(this.#now())}${suffix}`);
    }
    return this.#sessionDir;
  }

  #markTime(capturedAt: string): void {
    if (!this.#firstCapturedAt) this.#firstCapturedAt = capturedAt;
    if (!this.#lastCapturedAt || capturedAt > this.#lastCapturedAt) {
      this.#lastCapturedAt = capturedAt;
    }
  }

  async #writeSummary(dir: string): Promise<void> {
    const summary = this.summary() ?? (this.#modeBRun ? { modeBRun: this.#modeBRun } : null);
    if (!summary) return;
    const target = join(dir, "summary.json");
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }
}
