import {
  ModeBStrategySchema,
  type ModeBRunSummary,
  type ModeBStopReason,
  type ModeBStrategy,
} from "@nmc/core";
import type { SessionArea } from "./capture-session.js";
import { isModeBPageReport, type ModeBPageReport, type ModeBStepMessage } from "./messages.js";

/**
 * Mode B: open x.com/home on a surface the user does not look at and
 * scroll it until enough distinct organic posts were collected. The
 * page's own HomeTimeline responses are picked up by the Mode A
 * listener; nothing here requests X directly.
 *
 * The worker drives every step (a message per step) because hidden
 * pages get their timers throttled. Run state lives in
 * `chrome.storage.session` so a restarted service worker resumes it
 * (the background's alarm watchdog calls `resume()`).
 */

export const X_HOME_URL = "https://x.com/home";
/** chrome.storage.session: the run in progress (read by the UI pages). */
export const MODE_B_RUN_KEY = "nmc-mode-b-run";
/** chrome.storage.local: the last finished run's summary (counts only). */
export const MODE_B_LAST_RUN_KEY = "nmc-mode-b-last-run";
/** Optional permissions Mode B asks for when it is switched on. */
export const MODE_B_PERMISSIONS = ["alarms"];

export interface ModeBLimits {
  /** Hard ceiling for one run. */
  maxDurationMs: number;
  /** Steps in a row without a new distinct post before giving up. */
  stallSteps: number;
  /** Steps in a row the page did not answer before giving up. */
  maxUnansweredSteps: number;
  /** Lets the page load and fetch its first timeline before scrolling. */
  firstStepDelayMs: number;
  /** A step the page has not answered by then counts as unanswered. */
  stepTimeoutMs: number;
}

export const MODE_B_LIMITS: ModeBLimits = {
  maxDurationMs: 10 * 60_000,
  stallSteps: 8,
  maxUnansweredSteps: 5,
  firstStepDelayMs: 6_000,
  stepTimeoutMs: 5_000,
};

/** Pause between steps: 1.8–3.5 s — reading pace, without dawdling. */
export function stepDelayMs(random: number): number {
  return 1_800 + Math.floor(random * 1_700);
}

export interface WindowBounds {
  left?: number | undefined;
  top?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export type SurfaceRequest =
  | { kind: "window"; create: chrome.windows.CreateData }
  | { kind: "tab"; create: chrome.tabs.CreateProperties };

const OFFSCREEN_SIZE = { width: 480, height: 720 };
/** How much of the off-screen window may stay inside the user's window. */
const OFFSCREEN_PEEK = 40;

/**
 * What to open for a strategy. The off-screen window is placed past the
 * bottom-right corner of the user's (last focused) window; the browser
 * or OS may pull it back so a sliver stays on screen.
 */
export function surfaceRequest(strategy: ModeBStrategy, focused: WindowBounds): SurfaceRequest {
  switch (strategy) {
    case "minimized-window":
      return {
        kind: "window",
        create: { url: X_HOME_URL, state: "minimized", focused: false },
      };
    case "background-tab":
      return { kind: "tab", create: { url: X_HOME_URL, active: false } };
    case "offscreen-window":
      return {
        kind: "window",
        create: {
          url: X_HOME_URL,
          state: "normal",
          focused: false,
          ...OFFSCREEN_SIZE,
          left: (focused.left ?? 0) + (focused.width ?? 1280) - OFFSCREEN_PEEK,
          top: (focused.top ?? 0) + (focused.height ?? 800) - OFFSCREEN_PEEK,
        },
      };
  }
}

/** True for X's rate-limit answer: HTTP 429 or GraphQL error code 88. */
export function isRateLimited(status: number | undefined, payload: unknown): boolean {
  if (status === 429) return true;
  if (typeof payload !== "object" || payload === null) return false;
  const errors = (payload as Record<string, unknown>)["errors"];
  return (
    Array.isArray(errors) &&
    errors.some(
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as Record<string, unknown>)["code"] === 88,
    )
  );
}

export interface ModeBRun {
  strategy: ModeBStrategy;
  counter: "host" | "extension";
  target: number;
  startedAt: number;
  tabId: number;
  /** Set when the run opened its own window (closed as a whole). */
  windowId: number | null;
  scrollCount: number;
  scrollMovedCount: number;
  hiddenStepCount: number;
  responseCount: number;
  uniquePostCount: number;
  /** uniquePostCount when it last grew at a step. */
  countAtLastProgress: number;
  stepsWithoutProgress: number;
  unansweredSteps: number;
}

export interface ModeBStart {
  strategy: ModeBStrategy;
  target: number;
  counter: "host" | "extension";
}

function newRun(
  start: ModeBStart,
  now: number,
  tabId: number,
  windowId: number | null,
): ModeBRun {
  return {
    ...start,
    startedAt: now,
    tabId,
    windowId,
    scrollCount: 0,
    scrollMovedCount: 0,
    hiddenStepCount: 0,
    responseCount: 0,
    uniquePostCount: 0,
    countAtLastProgress: 0,
    stepsWithoutProgress: 0,
    unansweredSteps: 0,
  };
}

const PAGE_STOP: Partial<Record<ModeBPageReport["page"], ModeBStopReason>> = {
  login: "not-logged-in",
  error: "error-page",
  away: "navigated-away",
};

/**
 * Folds one step's outcome (`null` = the page did not answer) into the
 * run and decides whether it ends here.
 */
export function applyStep(
  run: ModeBRun,
  report: ModeBPageReport | null,
  now: number,
  limits: ModeBLimits = MODE_B_LIMITS,
): { run: ModeBRun; stop: ModeBStopReason | null } {
  if (now - run.startedAt >= limits.maxDurationMs) return { run, stop: "timeout" };
  const next = { ...run };
  if (report === null) {
    next.unansweredSteps += 1;
    if (next.unansweredSteps >= limits.maxUnansweredSteps) {
      return { run: next, stop: "page-unresponsive" };
    }
  } else {
    next.unansweredSteps = 0;
    if (report.hidden) next.hiddenStepCount += 1;
    const pageStop = PAGE_STOP[report.page];
    if (pageStop) return { run: next, stop: pageStop };
    next.scrollCount += 1;
    if (report.scrolled) next.scrollMovedCount += 1;
  }
  if (next.uniquePostCount > next.countAtLastProgress) {
    next.countAtLastProgress = next.uniquePostCount;
    next.stepsWithoutProgress = 0;
  } else {
    next.stepsWithoutProgress += 1;
    if (next.stepsWithoutProgress >= limits.stallSteps) return { run: next, stop: "stalled" };
  }
  return { run: next, stop: null };
}

export function summarize(
  run: ModeBRun,
  endedAt: number,
  stopReason: ModeBStopReason,
): ModeBRunSummary {
  return {
    strategy: run.strategy,
    counter: run.counter,
    target: run.target,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, endedAt - run.startedAt),
    scrollCount: run.scrollCount,
    scrollMovedCount: run.scrollMovedCount,
    hiddenStepCount: run.hiddenStepCount,
    responseCount: run.responseCount,
    uniquePostCount: run.uniquePostCount,
    stopReason,
  };
}

/** A run that never started (e.g. a missing permission), for the last-run record. */
export function refusedRun(
  start: ModeBStart,
  now: number,
  reason: ModeBStopReason,
): ModeBRunSummary {
  return summarize(newRun(start, now, -1, null), now, reason);
}

const STOP_REASON_TEXT: Record<ModeBStopReason, string> = {
  "target-reached": "target reached",
  timeout: "time limit reached",
  stalled: "no new posts for several scrolls",
  "not-logged-in": "not logged in to X in this browser",
  "error-page": "X showed an error page",
  "navigated-away": "the tab left x.com/home",
  "rate-limited": "X rate-limited the timeline",
  "page-unresponsive": "the hidden page stopped responding",
  "tab-closed": "the tab was closed",
  cancelled: "stopped by you",
  "settings-changed": "settings changed during the run",
  "permission-missing": "Mode B permission not granted — re-enable Mode B in Options",
  "failed-to-open": "could not open the hidden tab",
};

export function describeStopReason(reason: ModeBStopReason): string {
  return STOP_REASON_TEXT[reason];
}

/** The browser surface the runner needs (adapter over chrome.* in background.ts). */
export interface ModeBBrowser {
  focusedWindowBounds(): Promise<WindowBounds>;
  openWindow(create: chrome.windows.CreateData): Promise<{ windowId: number; tabId: number }>;
  openTab(create: chrome.tabs.CreateProperties): Promise<{ tabId: number }>;
  closeWindow(windowId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  sendStep(tabId: number, message: ModeBStepMessage): Promise<unknown>;
}

export interface ModeBHooks {
  /** Called once per run with its final counts (after the surface closed). */
  onFinish(summary: ModeBRunSummary): Promise<void>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStoredRun(value: unknown): value is ModeBRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const counts = [
    "target",
    "startedAt",
    "scrollCount",
    "scrollMovedCount",
    "hiddenStepCount",
    "responseCount",
    "uniquePostCount",
    "countAtLastProgress",
    "stepsWithoutProgress",
    "unansweredSteps",
  ];
  return (
    ModeBStrategySchema.safeParse(v["strategy"]).success &&
    (v["counter"] === "host" || v["counter"] === "extension") &&
    typeof v["tabId"] === "number" &&
    (v["windowId"] === null || typeof v["windowId"] === "number") &&
    counts.every((key) => isCount(v[key]))
  );
}

export class ModeBRunner {
  readonly #browser: ModeBBrowser;
  readonly #area: SessionArea;
  readonly #hooks: ModeBHooks;
  readonly #limits: ModeBLimits;
  readonly #random: () => number;
  /** `undefined` until loaded from the session area. */
  #run: ModeBRun | null | undefined = undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises state changes; steps, counts and commands interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    browser: ModeBBrowser,
    area: SessionArea,
    hooks: ModeBHooks,
    options: { limits?: ModeBLimits; random?: () => number } = {},
  ) {
    this.#browser = browser;
    this.#area = area;
    this.#hooks = hooks;
    this.#limits = options.limits ?? MODE_B_LIMITS;
    this.#random = options.random ?? Math.random;
  }

  /** The run in progress, if any. */
  current(): Promise<ModeBRun | null> {
    return this.#enqueue(() => this.#load());
  }

  start(start: ModeBStart): Promise<"started" | "busy" | "failed"> {
    return this.#enqueue(async () => {
      if (await this.#load()) return "busy";
      const now = Date.now();
      let surface: { tabId: number; windowId: number | null };
      try {
        surface = await this.#open(start.strategy);
      } catch (error) {
        console.error(`[nmc] Mode B could not open its tab: ${String(error)}`);
        await this.#hooks.onFinish(refusedRun(start, now, "failed-to-open"));
        return "failed";
      }
      this.#run = newRun(start, now, surface.tabId, surface.windowId);
      await this.#save();
      this.#schedule(this.#limits.firstStepDelayMs);
      return "started";
    });
  }

  stop(reason: ModeBStopReason = "cancelled"): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (run) await this.#finish(run, reason);
    });
  }

  /** A new distinct-post count from `counter`; counts from the other side are ignored. */
  onCount(count: number, counter: ModeBRun["counter"]): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || run.counter !== counter) return;
      run.uniquePostCount = count;
      if (count >= run.target) await this.#finish(run, "target-reached");
      else await this.#save();
    });
  }

  /** A timeline response arrived from `tabId`; only the run's own tab counts. */
  onResponse(tabId: number | undefined, rateLimited: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || tabId !== run.tabId) return;
      run.responseCount += 1;
      if (rateLimited) await this.#finish(run, "rate-limited");
      else await this.#save();
    });
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (run && tabId === run.tabId) await this.#finish(run, "tab-closed", false);
    });
  }

  /** Re-arms stepping after a service-worker restart (alarm/startup). */
  resume(): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (run && this.#timer === null) this.#schedule(0);
    });
  }

  async #open(strategy: ModeBStrategy): Promise<{ tabId: number; windowId: number | null }> {
    const bounds =
      strategy === "offscreen-window"
        ? await this.#browser.focusedWindowBounds().catch(() => ({}))
        : {};
    const request = surfaceRequest(strategy, bounds);
    if (request.kind === "tab") {
      const { tabId } = await this.#browser.openTab(request.create);
      return { tabId, windowId: null };
    }
    return this.#browser.openWindow(request.create);
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#step().catch((error: unknown) => {
        console.error(`[nmc] Mode B step failed: ${String(error)}`);
      });
    }, delayMs);
  }

  #step(): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || this.#timer !== null) return;
      const report = await this.#ask(run.tabId);
      const { run: next, stop } = applyStep(run, report, Date.now(), this.#limits);
      this.#run = next;
      if (stop) {
        await this.#finish(next, stop);
        return;
      }
      await this.#save();
      this.#schedule(stepDelayMs(this.#random()));
    });
  }

  /** One step request; a frozen page never answers, so it is bounded. */
  async #ask(tabId: number): Promise<ModeBPageReport | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#limits.stepTimeoutMs);
    });
    try {
      const answer = await Promise.race([
        this.#browser.sendStep(tabId, { kind: "mode-b-step" }).catch(() => null),
        timeout,
      ]);
      return isModeBPageReport(answer) ? answer : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #finish(run: ModeBRun, reason: ModeBStopReason, close = true): Promise<void> {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#run = null;
    await this.#area.remove(MODE_B_RUN_KEY);
    if (close) {
      try {
        if (run.windowId !== null) await this.#browser.closeWindow(run.windowId);
        else await this.#browser.closeTab(run.tabId);
      } catch {
        // Already gone (closed by the user or the browser).
      }
    }
    await this.#hooks.onFinish(summarize(run, Date.now(), reason));
  }

  async #load(): Promise<ModeBRun | null> {
    if (this.#run !== undefined) return this.#run;
    const stored = (await this.#area.get(MODE_B_RUN_KEY))[MODE_B_RUN_KEY];
    this.#run = isStoredRun(stored) ? stored : null;
    return this.#run;
  }

  async #save(): Promise<void> {
    if (this.#run) await this.#area.set({ [MODE_B_RUN_KEY]: this.#run });
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
