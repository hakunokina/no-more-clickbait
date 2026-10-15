import { writeFile } from "node:fs/promises";
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
} from "../shared/status.js";
import { usageOf, type PipelineRunner } from "./pipeline-runner.js";

/**
 * The desktop app's orchestration, Electron-free so it is testable:
 * - "Collect new timeline" → `start-collection` to the newest host;
 * - `collection-complete` from a host → run the pipeline on that session;
 * - at start-up (and whenever a host connects) → run the newest complete,
 *   unprocessed session; older ones are marked superseded;
 * - writes `result.json`, `timeline.json` (the renderer's TimelineDoc)
 *   and `timeline.html` into the session folder, then
 *   `processed.json` (done / cancelled). A failed run stays unprocessed
 *   so "Try again" (or the next app start) can redo it without
 *   collecting again.
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
              message: `Automatic collection (Mode B) is off. Browse x.com/home in your browser; the timeline is prepared once ${target ?? "enough"} posts are collected.`,
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
    if (event.sessionId !== null) void this.runSession(event.sessionId);
  }

  cancel(): boolean {
    return this.#deps.runner.cancel();
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

  /** Runs the newest complete, unprocessed session; supersedes older ones. */
  async processPending(): Promise<void> {
    if (this.#busy) return;
    const pending = (await listSessions(this.#deps.sessionsRoot)).filter(
      (session) => session.complete && session.processed === null,
    );
    const newest = pending.pop();
    for (const old of pending) {
      await markSessionProcessed(old.dir, "superseded", () => this.#now());
    }
    if (newest && !this.#failed.has(newest.id)) await this.runSession(newest.id);
  }

  async runSession(sessionId: string): Promise<void> {
    if (this.#busy) {
      if (this.#status.run.sessionId !== sessionId) this.#queued = sessionId;
      return;
    }
    this.#busy = true;
    const startedAt = this.#now();
    this.#update((status) => {
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
      };
    });

    let session: LoadedSession;
    let settings: Settings;
    try {
      session = await loadSession(this.#deps.sessionsRoot, sessionId);
      settings = await this.#deps.loadSettings();
    } catch (error) {
      this.#failed.add(sessionId);
      this.#finish((status) => {
        status.run.stage = "error";
        status.run.error = {
          kind: "session-unreadable",
          message: "The collected posts could not be read back from disk.",
          detail: error instanceof Error ? error.message : String(error),
        };
      });
      return;
    }

    const collection = session.collection ?? null;
    const spanMs = collection
      ? Date.parse(collection.lastCapturedAt) - Date.parse(collection.firstCapturedAt)
      : null;
    const outcome = await this.#deps.runner.run(
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
    );

    if (outcome.status === "cancelled") {
      await markSessionProcessed(session.dir, "cancelled", () => this.#now()).catch(() => undefined);
      this.#finish((status) => {
        status.run.stage = "cancelled";
        status.run.usage = usageOf(outcome.metrics);
      });
      return;
    }
    if (outcome.status === "error") {
      this.#failed.add(sessionId);
      this.#deps.log?.(`run failed: ${outcome.error.kind}`);
      this.#finish((status) => {
        status.run.stage = "error";
        status.run.error = outcome.error;
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
      this.#failed.add(sessionId);
      this.#finish((status) => {
        status.run.stage = "error";
        status.run.error = {
          kind: "internal",
          message: "The timeline could not be written to disk.",
          detail: error instanceof Error ? error.message : String(error),
        };
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
