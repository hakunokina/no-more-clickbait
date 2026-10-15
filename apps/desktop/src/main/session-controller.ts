import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toTimelineDoc, type Settings, type TimelineDoc } from "@nmc/core";
import {
  listSessions,
  loadSession,
  markSessionProcessed,
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
  type RunError,
  type RunErrorKind,
} from "../shared/status.js";
import { usageOf, type PipelineRunner } from "./pipeline-runner.js";

/**
 * The desktop app's orchestration, Electron-free so it is testable:
 * - "Collect new timeline" → `start-collection` to the newest host;
 * - `collection-complete` from a host: a Mode B collection (the user
 *   asked for it) runs the pipeline at once; a Mode A one (the user's
 *   own scrolling reached the target) only becomes the *pending* session
 *   — the user is asked and "Build timeline" runs it (owner's decision:
 *   no LLM spend the user did not ask for);
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
  #lastTimeline: string | null = null;
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
      if (status.link.hosts === 0 && status.collection.state === "requested") {
        status.collection = {
          state: "refused",
          message: "The browser extension disconnected before answering.",
          target: null,
        };
      }
    });
    // A host connecting may follow a collection that finished while we
    // were closed or disconnected.
    if (connectedNow) void this.processPending();
  }

  async startCollection(): Promise<void> {
    if (isRunActive(this.#status.run.stage)) {
      this.#update((status) => {
        status.collection = {
          state: "refused",
          message: "A timeline is being prepared; wait for it or cancel it first.",
          target: null,
        };
      });
      return;
    }
    const settings = await this.#deps.loadSettings();
    const sent = this.#deps.sendToHost({
      type: "start-collection",
      target: settings.collectTarget,
    });
    this.#update((status) => {
      status.collection = sent
        ? { state: "requested", message: null, target: settings.collectTarget }
        : {
            state: "refused",
            message:
              "The browser or the extension is not running. Open Brave/Chrome with the extension, then try again.",
            target: null,
          };
    });
  }

  handleHostEvent(event: HostEvent): void {
    if (event.type === "collection-start-result") {
      this.#update((status) => {
        const target = event.target ?? status.collection.target;
        switch (event.outcome) {
          case "started":
          case "busy":
            status.collection = { state: "collecting", message: null, target };
            break;
          case "mode-b-off":
            status.collection = {
              state: "refused",
              message: `Automatic collection (Mode B) is off. Browse x.com/home in your browser; once ${target ?? "enough"} posts are collected you can build the timeline.`,
              target,
            };
            break;
          case "permission-missing":
            status.collection = {
              state: "refused",
              message:
                "The extension lacks a permission Mode B needs. Open the extension's options and turn Mode B on again.",
              target,
            };
            break;
          default:
            status.collection = {
              state: "refused",
              message: "The extension could not start collecting.",
              target,
            };
        }
      });
      return;
    }
    this.#deps.log?.(
      `collection complete: mode ${event.mode}, ${event.uniquePostCount} posts, reason ${event.reason}`,
    );
    this.#update((status) => {
      status.collection = {
        state: "idle",
        message:
          event.sessionId === null
            ? "The collection ended without any post (" + event.reason + ")."
            : null,
        target: null,
      };
    });
    if (event.sessionId === null) return;
    if (event.mode === "B") {
      void this.runSession(event.sessionId);
      return;
    }
    void this.#awaitConfirmation(event.sessionId, event.uniquePostCount, true);
  }

  /** Runs the pending (Mode A) session the user confirmed. */
  async buildPending(): Promise<void> {
    const pending = this.#status.pending;
    if (pending) await this.runSession(pending.sessionId);
  }

  /** One pending session at a time: a newer one supersedes it. */
  async #awaitConfirmation(
    sessionId: string,
    uniquePostCount: number,
    notify: boolean,
  ): Promise<void> {
    const previous = this.#status.pending;
    if (previous && previous.sessionId !== sessionId) {
      await markSessionProcessed(
        join(this.#deps.sessionsRoot, previous.sessionId),
        "superseded",
        () => this.#now(),
      ).catch(() => undefined);
    }
    this.#update((status) => {
      status.pending = { sessionId, uniquePostCount };
    });
    if (notify) this.#deps.onAwaitingConfirmation?.({ sessionId, uniquePostCount });
  }

  cancel(): boolean {
    if (this.#deps.runner.cancel()) return true;
    // Still reading the session back: stop before the runner starts.
    if (this.#busy && !this.#inRunner && this.#status.run.stage === "checking") {
      this.#cancelRequested = true;
      return true;
    }
    return false;
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
    if (!newest?.completion) {
      await this.#showLastFailure();
      return;
    }
    if (this.#failed.has(newest.id)) return;
    if (newest.completion.mode === "B") await this.runSession(newest.id);
    else if (this.#status.pending?.sessionId !== newest.id) {
      await this.#awaitConfirmation(newest.id, newest.completion.uniquePostCount, false);
    }
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
