import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  toTimelineDoc,
  type MissingSource,
  type Settings,
  type SourceCount,
  type TimelineDoc,
} from "@nmc/core";
import {
  listSessions,
  loadSession,
  markSessionProcessed,
  sessionStartedAt,
  type DesktopCommand,
  type HostEvent,
  type LoadedSession,
} from "@nmc/native-host";
import {
  EMPTY_COUNTS,
  EMPTY_USAGE,
  initialStatus,
  isRunActive,
  type DesktopStatus,
  type PendingCollection,
  type RunError,
  type RunErrorKind,
} from "../shared/status.js";
import { describeStopReason } from "../shared/format.js";
import { usageOf, type PipelineRunner } from "./pipeline-runner.js";

/**
 * The desktop app's orchestration, Electron-free so it is testable:
 * - "Collect new timeline" → `start-collection` to the newest host;
 * - `collection-progress` shows a Mode B run's "x / N"; a request the
 *   extension does not answer, or a collection that goes silent, ends
 *   in a message after a timeout;
 * - "Cancel" while collecting → `stop-collection`; the run ends as
 *   `cancelled` (never built), or counts as cancelled here when the
 *   extension does not confirm in time;
 * - `collection-complete` from a host (planCompletion): a Mode B
 *   collection (the user asked for it) runs the pipeline at once, even
 *   short of the target; a Mode A one (the user's own scrolling reached
 *   the target), or a Mode B run that stopped for a reason like "not
 *   logged in", only becomes the *pending* session — the user is asked
 *   and "Build timeline" runs it (owner's decision: no LLM spend the
 *   user did not ask for); a cancelled one is never built;
 * - Mode B sessions whose collection never completed are counted for
 *   the monitor (#refreshUnfinished), never deleted or run;
 * - at start-up (and whenever a host connects) the newest complete,
 *   unprocessed session is handled the same way; older ones are marked
 *   superseded;
 * - writes `result.json`, `timeline.json` (the renderer's TimelineDoc)
 *   and `timeline.html` into the session folder, then
 *   `processed.json` (done / cancelled / error). A failed run is marked
 *   `error` and never re-run on its own (it would spend tokens on every
 *   start): the next app start shows the error and "Try again" redoes it
 *   without collecting again.
 *
 * Logs and status carry counts only, never feed content.
 */

export const TIMELINE_FILE = "timeline.html";
export const TIMELINE_DOC_FILE = "timeline.json";
export const RESULT_FILE = "result.json";

export interface SessionControllerDeps {
  sessionsRoot: string;
  runner: PipelineRunner;
  loadSettings(): Promise<Settings>;
  /** Produces the reading window's HTML for a finished run. */
  renderTimeline(doc: TimelineDoc): string;
  /** Sends a command to the newest connected host; false when none. */
  sendToHost(command: DesktopCommand): boolean;
  onStatus(status: DesktopStatus): void;
  /** A Mode A collection waits for the user's go (tray notification). */
  onAwaitingConfirmation?(pending: { sessionId: string; uniquePostCount: number }): void;
  /** A timeline is ready (tray notification, reading window). */
  onReady(ready: { sessionId: string; timelinePath: string; selected: number }): void;
  log?(line: string): void;
  now?(): string;
  /** How long to wait for the extension's answer / its next progress. */
  collectionTimeoutsMs?: Partial<typeof DEFAULT_COLLECTION_TIMEOUTS>;
}

export const DEFAULT_COLLECTION_TIMEOUTS = {
  answerMs: 15_000,
  /** Mode B stops itself after ~20 s without new posts; this is the backstop. */
  silenceMs: 90_000,
};

/** Mode B stops after which the timeline is built from what was collected. */
const BUILD_AFTER_STOP: ReadonlySet<string> = new Set([
  "target-reached",
  "stalled",
  "timeout",
  "page-unresponsive",
  "rate-limited",
  "error-page",
]);

/**
 * Stops the user caused themselves: the session waits in the monitor
 * ("Build timeline anyway") without a notification.
 */
const QUIET_STOPS: ReadonlySet<string> = new Set(["settings-changed"]);

/**
 * What a finished collection with posts becomes (owner's decision):
 * - "build": the user asked for it (Mode B) and it ended normally or
 *   X stopped giving posts — run at once, even short of the target;
 * - "ask": Mode A, or a Mode B stop that may not reflect the user's
 *   intent (not logged in, tab closed…) — wait for "Build timeline";
 * - "drop": the user cancelled it — never built.
 */
export function planCompletion(mode: "A" | "B", reason: string): "build" | "ask" | "drop" {
  if (mode === "A") return "ask";
  if (reason === "cancelled") return "drop";
  return BUILD_AFTER_STOP.has(reason) ? "build" : "ask";
}

/**
 * Sources a desktop run collects from: the extension's X home timeline
 * (custom sites join here once the desktop collects them).
 */
const RUN_SOURCES: readonly string[] = ["x"];

/**
 * Enabled sources that delivered nothing while others did (a partial
 * timeline). A run where nothing delivered has no missing sources:
 * that is an empty or error timeline, not a partial one.
 */
export function missingSourcesOf(
  enabled: readonly string[],
  bySource: readonly SourceCount[] | undefined,
): MissingSource[] {
  const delivered = new Set(bySource?.map((count) => count.label));
  if (delivered.size === 0) return [];
  return enabled
    .filter((label) => !delivered.has(label))
    .map((label) => ({ label, reason: "Nothing was collected from this source." }));
}

export class SessionController {
  readonly #deps: SessionControllerDeps;
  #status: DesktopStatus = initialStatus();
  /** Sessions whose run failed in this app session: never retried automatically. */
  readonly #failed = new Set<string>();
  /** "Cancel" pressed before the runner started (loading the session). */
  #cancelRequested = false;
  /** The runner owns the run (its own cancel applies). */
  #inRunner = false;
  /** Session waiting for the current run to finish. */
  #queued: string | null = null;
  /** Gives up on a collection the extension went quiet about. */
  #watchdog: ReturnType<typeof setTimeout> | null = null;
  /** The collection was given up for silence (late progress revives it). */
  #silent = false;
  #lastTimeline: string | null = null;
  /** When this app asked for the collection in progress (null: unknown). */
  #requestedAt: string | null = null;
  /** A session is being run or rendered (wider than `runner.busy`). */
  #busy = false;

  constructor(deps: SessionControllerDeps) {
    this.#deps = deps;
  }

  get status(): DesktopStatus {
    return this.#status;
  }

  /** Path of the newest finished timeline, if any. */
  get timelinePath(): string | null {
    return this.#lastTimeline;
  }

  /**
   * The newest finished timeline if it is still on disk. A host may
   * have pruned its session folder since (heavy browsing): the status
   * then says the timeline is gone instead of opening an empty window.
   */
  async availableTimeline(): Promise<string | null> {
    const path = this.#lastTimeline;
    if (!path) return null;
    try {
      await access(path);
      return path;
    } catch {
      this.#lastTimeline = null;
      this.#update((status) => {
        status.run.hasTimeline = false;
        status.run.timelineGone = true;
      });
      return null;
    }
  }

  #now(): string {
    return this.#deps.now?.() ?? new Date().toISOString();
  }

  #update(mutate: (status: DesktopStatus) => void): void {
    const next = structuredClone(this.#status);
    mutate(next);
    this.#status = next;
    this.#deps.onStatus(next);
  }

  setLink(link: Partial<DesktopStatus["link"]>): void {
    const connectedNow = (link.hosts ?? 0) > this.#status.link.hosts;
    this.#update((status) => {
      status.link = { ...status.link, ...link };
    });
    if (this.#status.link.hosts === 0 && this.#status.collection.state === "cancelling") {
      this.#collectionCancelled();
    }
    if (this.#status.link.hosts === 0 && this.#status.collection.state === "requested") {
      this.#setCollection(() => ({
        state: "refused",
        message: "The browser extension disconnected before answering.",
        target: null,
        count: null,
      }));
    }
    // A host connecting may follow a collection that finished while we
    // were closed or disconnected.
    if (connectedNow) void this.processPending();
  }

  async startCollection(): Promise<void> {
    if (isRunActive(this.#status.run.stage)) {
      this.#setCollection(() => ({
        state: "refused",
        message: "A timeline is being prepared; wait for it or cancel it first.",
        target: null,
        count: null,
      }));
      return;
    }
    const settings = await this.#deps.loadSettings();
    const sent = this.#deps.sendToHost({
      type: "start-collection",
      target: settings.collectTarget,
    });
    this.#requestedAt = sent ? this.#now() : null;
    const { stage } = this.#status.run;
    if (sent && (stage === "error" || stage === "cancelled")) {
      // A new collection replaces the failed/cancelled run's "try again".
      this.#update((status) => {
        status.run.stage = "idle";
        status.run.error = null;
      });
    }
    this.#setCollection(() =>
      sent
        ? { state: "requested", message: null, target: settings.collectTarget, count: null }
        : {
            state: "refused",
            message:
              "The browser or the extension is not running. Open Brave/Chrome with the extension, then try again.",
            target: null,
            count: null,
          },
    );
  }

  handleHostEvent(event: HostEvent): void {
    // Cancelling: only the run's end (collection-complete) matters now —
    // plus a refusal, which ends "cancelling" at once instead of leaving
    // the user on "Cancelling…" until the timeout. A late "started"/"busy"
    // belongs to a run that no longer exists and stays ignored.
    const endsCancelling =
      event.type === "collection-complete" ||
      (event.type === "collection-start-result" &&
        event.outcome !== "started" &&
        event.outcome !== "busy");
    if (this.#status.collection.state === "cancelling" && !endsCancelling) {
      return;
    }
    if (event.type === "collection-start-result") {
      this.#setCollection((status) => {
        const target = event.target ?? status.collection.target;
        switch (event.outcome) {
          case "busy":
            // A run that began before our request: its session is older.
            this.#requestedAt = null;
            return { state: "collecting", message: null, target, count: null };
          case "started":
            return { state: "collecting", message: null, target, count: null };
          case "mode-b-off":
            return {
              state: "refused",
              message: `Automatic collection (Mode B) is off. Browse x.com/home in your browser; once ${target ?? "enough"} posts are collected you can build the timeline.`,
              target,
              count: null,
            };
          case "permission-missing":
            return {
              state: "refused",
              message:
                "The extension lacks a permission Mode B needs. Open the extension's options and turn Mode B on again.",
              target,
              count: null,
            };
          default:
            return {
              state: "refused",
              message: "The extension could not start collecting.",
              target,
              count: null,
            };
        }
      });
      return;
    }
    if (event.type === "collection-progress") {
      // A collection the silence timeout gave up on comes back to life.
      const { state } = this.#status.collection;
      if (state === "idle" || (state === "refused" && !this.#silent)) return;
      this.#setCollection(() => ({
        state: "collecting",
        message: null,
        target: event.target,
        count: event.uniquePostCount,
      }));
      return;
    }
    this.#deps.log?.(
      `collection complete: mode ${event.mode}, ${event.uniquePostCount} posts, reason ${event.reason}`,
    );
    void this.#handleCompletion({
      sessionId: event.sessionId,
      mode: event.mode,
      reason: event.reason,
      uniquePostCount: event.uniquePostCount,
      target: event.target ?? this.#status.collection.target,
      live: true,
    }).catch((error: unknown) => this.#deps.log?.(`completion failed: ${String(error)}`));
  }

  /** Decides what a finished collection becomes (see planCompletion). */
  async #handleCompletion(done: {
    sessionId: string | null;
    mode: "A" | "B";
    reason: string;
    uniquePostCount: number;
    target: number | null;
    /** Announced just now (not found on disk at start-up): notify the user. */
    live: boolean;
  }): Promise<void> {
    // Batches of ads/repeats only leave a folder but no post to build from.
    const empty = done.sessionId === null || done.uniquePostCount === 0;
    let plan = empty ? "drop" : planCompletion(done.mode, done.reason);
    if (plan === "build" && this.#status.collection.state === "cancelling") {
      // The user already cancelled: a late complete (e.g. target-reached
      // racing the stop) waits for their go instead of spending LLM.
      plan = "ask";
    }
    const reached = done.reason === "target-reached";
    const counted = done.target
      ? `${done.uniquePostCount} of ${done.target}`
      : `${done.uniquePostCount}`;
    let message: string | null = null;
    if (empty) {
      message = `The collection ended without any post (${describeStopReason(done.reason)}).`;
    } else if (plan === "drop") {
      message = `The collection was stopped (${describeStopReason(done.reason)}); no timeline was built.`;
    } else if (!reached) {
      message =
        plan === "build"
          ? `Target not reached — the timeline uses ${counted} posts (${describeStopReason(done.reason)}).`
          : `The collection stopped early (${describeStopReason(done.reason)}) with ${counted} posts.`;
    }
    // A session found on disk must not end a collection that is running now.
    const { state } = this.#status.collection;
    if (done.live || !isCollecting(state)) {
      this.#setCollection(() => ({ state: "idle", message, target: null, count: null }));
    }
    if (done.sessionId === null) return;
    const dir = join(this.#deps.sessionsRoot, done.sessionId);
    if (plan === "drop") {
      await markSessionProcessed(dir, "cancelled", () => this.#now()).catch(() => undefined);
    } else if (plan === "build") {
      await this.#refreshUnfinished();
      await this.runSession(done.sessionId);
      return;
    } else {
      await this.#awaitConfirmation(
        {
          sessionId: done.sessionId,
          uniquePostCount: done.uniquePostCount,
          mode: done.mode,
          reason: done.reason,
          target: done.target,
        },
        done.live && !QUIET_STOPS.has(done.reason),
      );
    }
    await this.#refreshUnfinished();
  }

  /** Runs the pending session the user confirmed. */
  async buildPending(): Promise<void> {
    const pending = this.#status.pending;
    if (pending) await this.runSession(pending.sessionId);
  }

  /** One pending session at a time: a newer one supersedes it. */
  async #awaitConfirmation(pending: PendingCollection, notify: boolean): Promise<void> {
    const previous = this.#status.pending;
    if (previous && previous.sessionId !== pending.sessionId) {
      await markSessionProcessed(
        join(this.#deps.sessionsRoot, previous.sessionId),
        "superseded",
        () => this.#now(),
      ).catch(() => undefined);
    }
    this.#update((status) => {
      status.pending = pending;
    });
    if (notify) {
      this.#deps.onAwaitingConfirmation?.({
        sessionId: pending.sessionId,
        uniquePostCount: pending.uniquePostCount,
      });
    }
  }

  /**
   * Replaces the collection state and re-arms its watchdog: a request
   * the extension never answers, or a collection that goes silent,
   * ends in a message instead of "collecting" forever.
   */
  #setCollection(next: (status: DesktopStatus) => DesktopStatus["collection"]): void {
    this.#update((status) => {
      status.collection = next(status);
    });
    this.#silent = false;
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = null;
    const { state } = this.#status.collection;
    const limits = { ...DEFAULT_COLLECTION_TIMEOUTS, ...this.#deps.collectionTimeoutsMs };
    if (state === "cancelling") {
      this.#watchdog = setTimeout(() => {
        this.#watchdog = null;
        this.#collectionCancelled();
      }, limits.answerMs);
      this.#watchdog.unref?.();
      return;
    }
    if (state !== "requested" && state !== "collecting") return;
    const waitMs = state === "requested" ? limits.answerMs : limits.silenceMs;
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null;
      const { count, target } = this.#status.collection;
      this.#setCollection((status) => ({
        ...status.collection,
        state: "refused",
        message:
          state === "requested"
            ? "The browser extension did not answer. Is the browser open with the extension enabled?"
            : `No word from the browser extension for ${Math.round(waitMs / 1000)} s — the collection may have stopped. Check the browser window` +
              (count !== null
                ? ` (${count}${target ? ` of ${target}` : ""} posts so far).`
                : "."),
      }));
      this.#silent = state === "collecting";
    }, waitMs);
    this.#watchdog.unref?.();
  }

  /**
   * Counts Mode B sessions with posts whose collection never completed
   * (the host died, the browser closed…). The user's own scrolling
   * (Mode A) is left alone: stopping short of the target is normal. The
   * newest session may still be collecting (its host process is alive)
   * unless it started before the collection this app is waiting for.
   */
  async #refreshUnfinished(): Promise<void> {
    const sessions = await listSessions(this.#deps.sessionsRoot);
    const newest = sessions[sessions.length - 1];
    const { state } = this.#status.collection;
    const since = isCollecting(state) ? this.#requestedAt : null;
    const newestStart = newest ? sessionStartedAt(newest.id) : null;
    const newestEnded = since !== null && newestStart !== null && newestStart < since;
    const unfinished = sessions.filter(
      (session) =>
        session.info?.mode === "B" &&
        session.completion === null &&
        session.processed === null &&
        session.batchCount > 0 &&
        (session !== newest || newestEnded),
    );
    const latest = unfinished[unfinished.length - 1];
    const next = {
      count: unfinished.length,
      newestAt: latest ? sessionStartedAt(latest.id) : null,
    };
    const current = this.#status.unfinished;
    if (current.count === next.count && current.newestAt === next.newestAt) return;
    this.#update((status) => {
      status.unfinished = next;
    });
  }

  cancel(): boolean {
    if (this.#deps.runner.cancel()) return true;
    if (this.#cancelCollection()) return true;
    // Still reading the session back: stop before the runner starts.
    if (this.#busy && !this.#inRunner && this.#status.run.stage === "checking") {
      this.#cancelRequested = true;
      return true;
    }
    return false;
  }

  /** Asks the extension to end the running collection (Mode B) as cancelled. */
  #cancelCollection(): boolean {
    const { state } = this.#status.collection;
    if (state !== "requested" && state !== "collecting") return false;
    if (!this.#deps.sendToHost({ type: "stop-collection" })) {
      this.#collectionCancelled();
      return true;
    }
    this.#setCollection((status) => ({
      ...status.collection,
      state: "cancelling",
      message: null,
    }));
    return true;
  }

  /** Ends a collection on this side only (the extension did not confirm). */
  #collectionCancelled(): void {
    this.#setCollection(() => ({
      state: "idle",
      message: "Collection cancelled; no timeline was built.",
      target: null,
      count: null,
    }));
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Re-runs the last session (after an error or a cancel). */
  async retry(): Promise<void> {
    const id = this.#status.run.sessionId;
    if (!id) return;
    this.#failed.delete(id);
    await this.runSession(id);
  }

  /**
   * Handles the newest complete, unprocessed session (Mode B: run,
   * Mode A: pending for the user's go); supersedes older ones.
   */
  async processPending(): Promise<void> {
    if (this.#busy) return;
    const pending = (await listSessions(this.#deps.sessionsRoot)).filter(
      (session) => session.completion !== null && session.processed === null,
    );
    const newest = pending.pop();
    for (const old of pending) {
      await markSessionProcessed(old.dir, "superseded", () => this.#now());
    }
    await this.#refreshUnfinished();
    if (!newest?.completion) {
      await this.#showLastFailure();
      return;
    }
    if (this.#failed.has(newest.id) || this.#status.pending?.sessionId === newest.id) return;
    await this.#handleCompletion({
      sessionId: newest.id,
      mode: newest.completion.mode,
      reason: newest.completion.reason,
      uniquePostCount: newest.completion.uniquePostCount,
      target: newest.completion.target ?? null,
      live: false,
    });
  }

  /**
   * At start-up: when the newest run (from an earlier app session)
   * failed, show it so the user can "Try again"; never re-run it.
   */
  async #showLastFailure(): Promise<void> {
    if (this.#status.run.stage !== "idle" || this.#busy) return;
    const last = (await listSessions(this.#deps.sessionsRoot))
      .filter((session) => session.processed && session.processed.status !== "superseded")
      .pop();
    if (last?.processed?.status !== "error" || this.#status.run.stage !== "idle") return;
    const saved = last.processed.error;
    this.#failed.add(last.id);
    this.#update((status) => {
      status.run.sessionId = last.id;
      status.run.stage = "error";
      status.run.endedAt = last.processed?.processedAt ?? null;
      status.run.error = {
        kind: isRunErrorKind(saved?.kind) ? saved.kind : "internal",
        message: saved?.message ?? "The last run failed.",
        detail: null,
      };
    });
  }

  async runSession(sessionId: string): Promise<void> {
    if (this.#busy) {
      if (this.#status.run.sessionId !== sessionId) this.#queued = sessionId;
      return;
    }
    this.#busy = true;
    this.#cancelRequested = false;
    const startedAt = this.#now();
    this.#update((status) => {
      if (status.pending?.sessionId === sessionId) status.pending = null;
      status.run = {
        stage: "checking",
        sessionId,
        startedAt,
        endedAt: null,
        counts: { ...EMPTY_COUNTS },
        usage: { ...EMPTY_USAGE },
        stageDurationsMs: {},
        collectionSpanMs: null,
        funnel: null,
        error: null,
        hasTimeline: false,
        timelineGone: false,
      };
    });

    let session: LoadedSession;
    let settings: Settings;
    try {
      session = await loadSession(this.#deps.sessionsRoot, sessionId);
      settings = await this.#deps.loadSettings();
    } catch (error) {
      await this.#fail(sessionId, {
        kind: "session-unreadable",
        message: "The collected posts could not be read back from disk.",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (this.#cancelRequested) {
      await markSessionProcessed(session.dir, "cancelled", () => this.#now()).catch(
        () => undefined,
      );
      this.#finish((status) => {
        status.run.stage = "cancelled";
      });
      return;
    }

    const collection = session.collection ?? null;
    const spanMs = collection
      ? Date.parse(collection.lastCapturedAt) - Date.parse(collection.firstCapturedAt)
      : null;
    this.#inRunner = true;
    const outcome = await this.#deps.runner
      .run(
        session.posts,
        settings,
        (progress) =>
          this.#update((status) => {
            status.run.stage = progress.stage;
            status.run.counts = progress.counts;
            status.run.usage = progress.usage;
            status.run.stageDurationsMs = progress.stageDurationsMs;
            status.run.collectionSpanMs = spanMs;
          }),
        collection ?? undefined,
      )
      .finally(() => {
        this.#inRunner = false;
      });

    if (outcome.status === "cancelled") {
      await markSessionProcessed(session.dir, "cancelled", () => this.#now()).catch(
        () => undefined,
      );
      this.#finish((status) => {
        status.run.stage = "cancelled";
        status.run.usage = usageOf(outcome.metrics);
      });
      return;
    }
    if (outcome.status === "error") {
      this.#deps.log?.(`run failed: ${outcome.error.kind}`);
      await this.#fail(sessionId, outcome.error, (status) => {
        status.run.usage = usageOf(outcome.metrics);
      });
      return;
    }

    this.#update((status) => {
      status.run.stage = "rendering";
    });
    const timelinePath = join(session.dir, TIMELINE_FILE);
    try {
      const doc = toTimelineDoc(
        {
          selected: outcome.result.posts,
          funnel: outcome.result.funnel,
          settings,
          ...(collection ? { collection } : {}),
          metrics: outcome.result.metrics,
          missingSources: missingSourcesOf(RUN_SOURCES, outcome.result.metrics.bySource),
        },
        new Date(this.#now()),
      );
      await writeFile(
        join(session.dir, RESULT_FILE),
        `${JSON.stringify({ settings, ...outcome.result }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(session.dir, TIMELINE_DOC_FILE), `${JSON.stringify(doc)}\n`, "utf8");
      await writeFile(timelinePath, this.#deps.renderTimeline(doc), "utf8");
      await markSessionProcessed(session.dir, "done", () => this.#now());
    } catch (error) {
      await this.#fail(sessionId, {
        kind: "internal",
        message: "The timeline could not be written to disk.",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#lastTimeline = timelinePath;
    this.#finish((status) => {
      status.run.stage = "ready";
      status.run.counts = outcome.counts;
      status.run.funnel = outcome.result.funnel;
      status.run.usage = usageOf(outcome.result.metrics);
      status.run.stageDurationsMs = outcome.result.metrics.stageDurationsMs;
      status.run.collectionSpanMs = spanMs;
      status.run.hasTimeline = true;
    });
    this.#deps.onReady({ sessionId, timelinePath, selected: outcome.result.posts.length });
  }

  /** Ends a run in error; marks the session so no app start re-runs it. */
  async #fail(
    sessionId: string,
    error: RunError,
    mutate?: (status: DesktopStatus) => void,
  ): Promise<void> {
    this.#failed.add(sessionId);
    await markSessionProcessed(
      join(this.#deps.sessionsRoot, sessionId),
      "error",
      () => this.#now(),
      { kind: error.kind, message: error.message.slice(0, 500) },
    ).catch(() => undefined);
    this.#finish((status) => {
      status.run.stage = "error";
      status.run.error = error;
      mutate?.(status);
    });
  }

  #finish(mutate: (status: DesktopStatus) => void): void {
    this.#update((status) => {
      mutate(status);
      status.run.endedAt = this.#now();
    });
    this.#busy = false;
    const queued = this.#queued;
    this.#queued = null;
    if (queued) void this.runSession(queued);
  }
}

/** A collection this app asked for may still be running. */
function isCollecting(state: DesktopStatus["collection"]["state"]): boolean {
  return state === "requested" || state === "collecting" || state === "cancelling";
}

const RUN_ERROR_KINDS: readonly RunErrorKind[] = [
  "cli-not-found",
  "cli-not-authenticated",
  "cli-error",
  "session-unreadable",
  "internal",
];

function isRunErrorKind(kind: string | undefined): kind is RunErrorKind {
  return (RUN_ERROR_KINDS as readonly (string | undefined)[]).includes(kind);
}
