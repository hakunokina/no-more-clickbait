import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  countTimelineEntries,
  createHardFilter,
  parseHomeTimeline,
  type CaptureStats,
  type CollectionMetrics,
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
 */

export interface CaptureSummary extends CollectionMetrics {
  /** Last minus first capture time, for the "collection span" measurement. */
  collectionSpanMs: number;
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
  #sessionDir: string | null = null;
  #sequence = 0;
  #firstCapturedAt: string | null = null;
  #lastCapturedAt: string | null = null;
  #responseCount = 0;
  #postCount = 0;
  #promotedCount = 0;
  #oversizedCount = 0;
  readonly #uniqueFilter = createHardFilter();
  /** Serialises file writes; handler calls may arrive concurrently. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    rootDir: string = defaultCaptureRoot(),
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#rootDir = rootDir;
    this.#now = now;
  }

  get stats(): CaptureStats {
    return {
      responseCount: this.#responseCount,
      postCount: this.#postCount,
      uniquePostCount: this.#uniqueFilter.stats.kept,
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
      uniquePostCount: this.#uniqueFilter.stats.kept,
      responseCount: this.#responseCount,
      promotedCount: this.#promotedCount,
      oversizedCount: this.#oversizedCount,
      collectionSpanMs: Date.parse(this.#lastCapturedAt) - Date.parse(this.#firstCapturedAt),
    };
  }

  /** Stores one raw capture verbatim and returns its sequence number. */
  async store(capture: RawCapture): Promise<number> {
    return this.#enqueue(async () => {
      const dir = this.#ensureSession();
      await mkdir(dir, { recursive: true });
      this.#sequence += 1;
      const sequence = this.#sequence;
      const name = `${String(sequence).padStart(4, "0")}-${stampOf(capture.capturedAt)}-${safeOperation(capture.operation)}.json`;
      await writeFile(join(dir, name), capture.bodyText, "utf8");
      this.#markTime(capture.capturedAt);
      this.#responseCount += 1;
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
      this.#sessionDir = join(this.#rootDir, stampOf(this.#now()));
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
    const summary = this.summary();
    if (!summary) return;
    const target = join(dir, "summary.json");
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }
}
