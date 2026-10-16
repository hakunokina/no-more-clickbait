import {
  CollectSourceSchema,
  ModeBPacingSchema,
  ModeBSurfaceSchema,
  type CollectSource,
  type ModeBLeg,
  type ModeBPacing,
  type ModeBRunSummary,
  type ModeBStopReason,
  type ModeBSurface,
} from "@nmc/core";
import type { SessionArea } from "./capture-session.js";
import { t, type MessageKey } from "./i18n.js";
import { isModeBPageReport, type ModeBPageReport, type ModeBStepMessage } from "./messages.js";
import { loadSettings } from "./settings.js";

/**
 * Mode B: open x.com/home on a surface the user does not look at and
 * scroll it until enough distinct organic posts were collected. The
 * page's own HomeTimeline responses are picked up by the Mode A
 * listener; nothing here requests X directly.
 *
 * The worker drives every step (a message per step) because hidden
 * pages get their timers throttled (1 s, later 1 min). The worker's own
 * short timers are not: each step's message and the page's responses
 * keep it awake, and `chrome.alarms` (30 s minimum) could not pace steps
 * anyway. Run state lives in `chrome.storage.session` so a restarted
 * service worker resumes it (the background's alarm watchdog calls
 * `resume()`).
 *
 * Each step jumps to the bottom of the timeline and the next one follows
 * a short random timer: `normal` pacing (the default) is five times the
 * first version's pace, `fast` ten times. Stall and unresponsiveness
 * limits are measured in time, so both paces give up after the same wait.
 *
 * A run may scroll more than one feed (X, then Instagram): one "leg"
 * per feed, in the same window, each with its own count, target, limits
 * and stop reason. A leg that ends for its own reason (target, stall,
 * not logged in…) hands the tab over to the next feed; a cancel, a
 * settings change or a closed tab ends the whole run.
 */

export const X_HOME_URL = "https://x.com/home";
export const INSTAGRAM_HOME_URL = "https://www.instagram.com/";
/** Where each feed's leg scrolls. */
export const SOURCE_HOME_URLS: Readonly<Record<CollectSource, string>> = {
  x: X_HOME_URL,
  instagram: INSTAGRAM_HOME_URL,
};
/** Stops that end the whole run, whatever feeds are still to come. */
const RUN_ENDING_STOPS: ReadonlySet<ModeBStopReason> = new Set([
  "cancelled",
  "settings-changed",
  "tab-closed",
  "permission-missing",
  "failed-to-open",
]);
/** chrome.storage.session: the run in progress (read by the UI pages). */
export const MODE_B_RUN_KEY = "nmc-mode-b-run";
/** chrome.storage.local: the last finished run's summary (counts only). */
export const MODE_B_LAST_RUN_KEY = "nmc-mode-b-last-run";
/**
 * chrome.storage.local: where the pacing trial kept its choice before it
 * moved into Settings (`modeBPacing`). Its values (`fixed`, `response`)
 * both map to the default `normal`, so it is only removed.
 */
export const LEGACY_MODE_B_PACING_KEY = "nmc-mode-b-pacing";
export const DEFAULT_MODE_B_PACING: ModeBPacing = "normal";
/** Optional permissions Mode B asks for when it is switched on. */
export const MODE_B_PERMISSIONS = ["alarms"];

export interface ModeBLimits {
  /** Hard ceiling for one run. */
  maxDurationMs: number;
  /** Time without a new distinct post before giving up. */
  stallMs: number;
  /** Time the page went without answering a step before giving up. */
  maxUnansweredMs: number;
  /** Lets the page load and fetch its first timeline before scrolling. */
  firstStepDelayMs: number;
  /** A step the page has not answered by then counts as unanswered. */
  stepTimeoutMs: number;
}

/** Mean pause of the first, timer-paced version (1.8–3.5 s). */
const FIRST_VERSION_PAUSE_MS = 2_650;

export const MODE_B_LIMITS: ModeBLimits = {
  maxDurationMs: 10 * 60_000,
  // The first version's 8 and 5 steps, turned into the time they took.
  stallMs: 8 * FIRST_VERSION_PAUSE_MS,
  maxUnansweredMs: 5 * FIRST_VERSION_PAUSE_MS,
  firstStepDelayMs: 6_000,
  stepTimeoutMs: 5_000,
};

/**
 * The pause between jumps: `normal` 0.36–0.70 s (the first version's
 * 1.8–3.5 s, five times faster), `fast` half of it, 0.18–0.35 s.
 */
export function stepDelayMs(
  random: number,
  pacing: ModeBPacing = DEFAULT_MODE_B_PACING,
): number {
  const pause = 360 + Math.floor(random * 340);
  return pacing === "fast" ? Math.floor(pause / 2) : pause;
}

export interface WindowBounds {
  left?: number | undefined;
  top?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  state?: string | undefined;
}

const CORNER_SIZE = { width: 480, height: 720 };
/**
 * Chromium refuses `windows.create` bounds less than half inside the
 * screen ("Bounds must be at least 50% within visible screen space"), so
 * a window cannot be pushed off-screen. The corner window keeps 60% of
 * its width inside the user's window and hangs the rest off its right edge.
 */
const CORNER_VISIBLE_WIDTH = Math.round(CORNER_SIZE.width * 0.6);
const DEFAULT_BOUNDS = { left: 0, top: 0, width: 1280, height: 800 };

/**
 * The window to open for a surface. The `offscreen-window` surface (kept
 * under its stored name) is a small visible window at the bottom-right
 * corner of the user's (last focused) window.
 */
export function surfaceRequest(
  strategy: ModeBSurface,
  focused: WindowBounds,
  url: string = X_HOME_URL,
): chrome.windows.CreateData {
  switch (strategy) {
    case "minimized-window":
      return { url, state: "minimized", focused: false };
    case "offscreen-window": {
      // A minimized window's bounds say nothing about the screen.
      const anchor = focused.state === "minimized" ? DEFAULT_BOUNDS : focused;
      const left = anchor.left ?? DEFAULT_BOUNDS.left;
      const top = anchor.top ?? DEFAULT_BOUNDS.top;
      const right = left + (anchor.width ?? DEFAULT_BOUNDS.width);
      const bottom = top + (anchor.height ?? DEFAULT_BOUNDS.height);
      return {
        url,
        state: "normal",
        focused: false,
        ...CORNER_SIZE,
        left: right - CORNER_VISIBLE_WIDTH,
        top: Math.max(top, bottom - CORNER_SIZE.height),
      };
    }
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
  strategy: ModeBSurface;
  pacing: ModeBPacing;
  counter: "host" | "extension";
  target: number;
  startedAt: number;
  tabId: number;
  /** The run's own window (closed as a whole); null only for a refused run. */
  windowId: number | null;
  scrollCount: number;
  scrollMovedCount: number;
  hiddenStepCount: number;
  responseCount: number;
  uniquePostCount: number;
  /** When the first step ran. */
  firstStepAt: number | null;
  /** uniquePostCount when it last grew at a step, and when. */
  countAtLastProgress: number;
  lastProgressAt: number | null;
  /** Since when the page has not answered a step (null: it answered the last one). */
  unansweredSince: number | null;
  /** responseCount at the previous step. */
  responsesAtLastStep: number;
  stepsWithNewResponse: number;
  /** The last step's failure as the browser worded it (no page content). */
  lastError: string | null;
  /** The feed this leg scrolls (absent: X; runs stored before legs existed). */
  source?: CollectSource;
  /** Feeds still to scroll after this one, in order. */
  nextSources?: CollectSource[];
  /** The legs that ended before this one. */
  legs?: ModeBLeg[];
}

export interface ModeBStart {
  strategy: ModeBSurface;
  target: number;
  /** Who counts X's posts; every other feed is counted by the extension. */
  counter: "host" | "extension";
  /** The feeds to scroll, one after the other (absent or empty: X). */
  sources?: CollectSource[];
}

function newRun(
  start: ModeBStart,
  pacing: ModeBPacing,
  now: number,
  tabId: number,
  windowId: number | null,
  source: CollectSource = "x",
): ModeBRun {
  return {
    strategy: start.strategy,
    target: start.target,
    counter: source === "x" ? start.counter : "extension",
    pacing,
    startedAt: now,
    tabId,
    windowId,
    scrollCount: 0,
    scrollMovedCount: 0,
    hiddenStepCount: 0,
    responseCount: 0,
    uniquePostCount: 0,
    firstStepAt: null,
    countAtLastProgress: 0,
    lastProgressAt: null,
    unansweredSince: null,
    responsesAtLastStep: 0,
    stepsWithNewResponse: 0,
    lastError: null,
    ...(source === "x" ? {} : { source }),
  };
}

/** The feed a stored run's current leg scrolls. */
export function runSource(run: Pick<ModeBRun, "source">): CollectSource {
  return run.source ?? "x";
}

const PAGE_STOP: Partial<Record<ModeBPageReport["page"], ModeBStopReason>> = {
  login: "not-logged-in",
  error: "error-page",
  away: "navigated-away",
};

/** A response arrived since the last step (the page's first one excepted). */
function hasNewResponse(run: ModeBRun): boolean {
  return run.responseCount > run.responsesAtLastStep && run.responsesAtLastStep > 0;
}

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
  next.firstStepAt ??= now;
  // The page's first response is its initial load, not a scroll's doing.
  if (hasNewResponse(next)) next.stepsWithNewResponse += 1;
  next.responsesAtLastStep = next.responseCount;
  if (report === null) {
    next.unansweredSince ??= now;
    if (now - next.unansweredSince >= limits.maxUnansweredMs) {
      return { run: next, stop: "page-unresponsive" };
    }
  } else {
    next.unansweredSince = null;
    if (report.hidden) next.hiddenStepCount += 1;
    const pageStop = PAGE_STOP[report.page];
    if (pageStop) return { run: next, stop: pageStop };
    next.scrollCount += 1;
    if (report.scrolled) next.scrollMovedCount += 1;
  }
  if (next.lastProgressAt === null || next.uniquePostCount > next.countAtLastProgress) {
    next.countAtLastProgress = next.uniquePostCount;
    next.lastProgressAt = now;
  } else if (now - next.lastProgressAt >= limits.stallMs) {
    return { run: next, stop: "stalled" };
  }
  return { run: next, stop: null };
}

const MAX_ERROR_LENGTH = 300;

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

export function summarize(
  run: ModeBRun,
  endedAt: number,
  stopReason: ModeBStopReason,
  error: string | null = null,
): ModeBRunSummary {
  const scrollingMs = run.firstStepAt === null ? 0 : endedAt - run.firstStepAt;
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
    pacing: run.pacing,
    scrollsPerMinute:
      scrollingMs > 0 ? Math.round((run.scrollCount * 600_000) / scrollingMs) / 10 : 0,
    // The last step's response arrives after it; no later step counts it.
    stepsWithNewResponse: run.stepsWithNewResponse + (hasNewResponse(run) ? 1 : 0),
    ...(error === null ? {} : { error }),
    ...(run.source === undefined || run.source === "x" ? {} : { source: run.source }),
  };
}

/** A leg's counts, from its summary. */
export function legOf(summary: ModeBRunSummary): ModeBLeg {
  return {
    source: summary.source ?? "x",
    counter: summary.counter,
    target: summary.target,
    uniquePostCount: summary.uniquePostCount,
    responseCount: summary.responseCount,
    scrollCount: summary.scrollCount,
    durationMs: summary.durationMs,
    stopReason: summary.stopReason,
  };
}

/** Every leg of a finished run: its `legs`, or the run itself when it scrolled one feed. */
export function legsOf(summary: ModeBRunSummary): ModeBLeg[] {
  return summary.legs ?? [legOf(summary)];
}

/**
 * Why a run over several feeds ended, as a whole: a stop that ended the
 * run (cancel…) is the run's; otherwise every feed reaching its target
 * is "target-reached", else the first feed's stop that was not. A run
 * of one feed ends for that feed's reason.
 */
export function runStopReason(summary: ModeBRunSummary): ModeBStopReason {
  const legs = legsOf(summary);
  const ending = legs.find((leg) => RUN_ENDING_STOPS.has(leg.stopReason));
  if (ending) return ending.stopReason;
  return (
    legs.find((leg) => leg.stopReason !== "target-reached")?.stopReason ?? "target-reached"
  );
}

/** A run that never started (e.g. a missing permission), for the last-run record. */
export function refusedRun(
  start: ModeBStart,
  now: number,
  reason: ModeBStopReason,
  error: string | null = null,
  pacing: ModeBPacing = DEFAULT_MODE_B_PACING,
): ModeBRunSummary {
  const [first = "x", ...rest] = start.sources ?? [];
  const summary = summarize(newRun(start, pacing, now, -1, null, first), now, reason, error);
  if (rest.length === 0) return summary;
  const leg = legOf(summary);
  return {
    ...summary,
    legs: [first, ...rest].map((source) => ({
      ...leg,
      source,
      counter: source === "x" ? start.counter : "extension",
    })),
  };
}

const STOP_REASON_TEXT: Record<ModeBStopReason, MessageKey> = {
  "target-reached": "stopTargetReached",
  timeout: "stopTimeout",
  stalled: "stopStalled",
  "not-logged-in": "stopNotLoggedIn",
  "error-page": "stopErrorPage",
  "navigated-away": "stopNavigatedAway",
  "rate-limited": "stopRateLimited",
  "page-unresponsive": "stopPageUnresponsive",
  "tab-closed": "stopTabClosed",
  cancelled: "stopCancelled",
  "settings-changed": "stopSettingsChanged",
  "permission-missing": "stopPermissionMissing",
  "failed-to-open": "stopFailedToOpen",
};

/** Where a reason names the site, Instagram has its own words. */
const INSTAGRAM_STOP_REASON_TEXT: Partial<Record<ModeBStopReason, MessageKey>> = {
  "not-logged-in": "stopNotLoggedInInstagram",
  "error-page": "stopErrorPageInstagram",
  "navigated-away": "stopNavigatedAwayInstagram",
  "rate-limited": "stopRateLimitedInstagram",
};

export function describeStopReason(
  reason: ModeBStopReason,
  source: CollectSource = "x",
): string {
  const key = source === "instagram" ? INSTAGRAM_STOP_REASON_TEXT[reason] : undefined;
  return t(key ?? STOP_REASON_TEXT[reason]);
}

const SOURCE_NAME_KEYS: Readonly<Record<CollectSource, MessageKey>> = {
  x: "sourceX",
  instagram: "sourceInstagram",
};

/** A feed's name as the UI shows it. */
export function sourceName(source: CollectSource): string {
  return t(SOURCE_NAME_KEYS[source]);
}

/** Each leg as "X: 250 / 250 (target reached)". */
export function legsText(legs: readonly ModeBLeg[]): string {
  return legs
    .map((leg) =>
      t(
        "legLine",
        sourceName(leg.source),
        leg.uniquePostCount,
        leg.target,
        describeStopReason(leg.stopReason, leg.source),
      ),
    )
    .join("; ");
}

/** The browser surface the runner needs (adapter over chrome.* in background.ts). */
export interface ModeBBrowser {
  focusedWindowBounds(): Promise<WindowBounds>;
  openWindow(create: chrome.windows.CreateData): Promise<{ windowId: number; tabId: number }>;
  /** Unused since the background tab was retired. */
  openTab(create: chrome.tabs.CreateProperties): Promise<{ tabId: number }>;
  closeWindow(windowId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  sendStep(tabId: number, message: ModeBStepMessage): Promise<unknown>;
  /** Loads the next feed's page in the run's tab. */
  navigate(tabId: number, url: string): Promise<void>;
}

export interface ModeBHooks {
  /**
   * Called once per run with its final counts (after the surface
   * closed): the last leg's, with every leg in `legs` when the run was
   * to scroll more than one feed (feeds it never reached included, with
   * the stop that ended the run).
   */
  onFinish(summary: ModeBRunSummary): Promise<void>;
  /** A leg ended and feed `next` takes the tab over (not called for the last leg). */
  onLegFinish?(summary: ModeBRunSummary, next: CollectSource): Promise<void>;
}

/**
 * The pacing for the next run, from Settings; anything unreadable means
 * the default. Also drops the pacing trial's old storage key.
 */
export async function loadModeBPacing(
  load: () => Promise<{ modeBPacing: ModeBPacing }> = loadSettings,
  local: Pick<chrome.storage.StorageArea, "remove"> = chrome.storage.local,
): Promise<ModeBPacing> {
  try {
    await local.remove(LEGACY_MODE_B_PACING_KEY);
  } catch {
    // Retried on the next run.
  }
  try {
    return (await load()).modeBPacing;
  } catch {
    return DEFAULT_MODE_B_PACING;
  }
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
    "responsesAtLastStep",
    "stepsWithNewResponse",
  ];
  const times = ["firstStepAt", "lastProgressAt", "unansweredSince"];
  const sources = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every((source) => CollectSourceSchema.safeParse(source).success));
  return (
    ModeBSurfaceSchema.safeParse(v["strategy"]).success &&
    ModeBPacingSchema.safeParse(v["pacing"]).success &&
    (v["source"] === undefined || CollectSourceSchema.safeParse(v["source"]).success) &&
    sources(v["nextSources"]) &&
    (v["legs"] === undefined || Array.isArray(v["legs"])) &&
    (v["counter"] === "host" || v["counter"] === "extension") &&
    typeof v["tabId"] === "number" &&
    (v["windowId"] === null || typeof v["windowId"] === "number") &&
    (v["lastError"] === null || typeof v["lastError"] === "string") &&
    counts.every((key) => isCount(v[key])) &&
    times.every((key) => v[key] === null || isCount(v[key]))
  );
}

interface StepAnswer {
  report: ModeBPageReport | null;
  error: string | null;
}

export class ModeBRunner {
  readonly #browser: ModeBBrowser;
  readonly #area: SessionArea;
  readonly #hooks: ModeBHooks;
  readonly #limits: ModeBLimits;
  readonly #random: () => number;
  readonly #loadPacing: () => Promise<ModeBPacing>;
  /** `undefined` until loaded from the session area. */
  #run: ModeBRun | null | undefined = undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises state changes; steps, counts and commands interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    browser: ModeBBrowser,
    area: SessionArea,
    hooks: ModeBHooks,
    options: {
      limits?: ModeBLimits;
      random?: () => number;
      loadPacing?: () => Promise<ModeBPacing>;
    } = {},
  ) {
    this.#browser = browser;
    this.#area = area;
    this.#hooks = hooks;
    this.#limits = options.limits ?? MODE_B_LIMITS;
    this.#random = options.random ?? Math.random;
    this.#loadPacing = options.loadPacing ?? (() => loadModeBPacing());
  }

  /** The run in progress, if any. */
  current(): Promise<ModeBRun | null> {
    return this.#enqueue(() => this.#load());
  }

  start(start: ModeBStart): Promise<"started" | "busy" | "failed"> {
    return this.#enqueue(async () => {
      if (await this.#load()) return "busy";
      const pacing = await this.#loadPacing();
      const now = Date.now();
      const [first = "x", ...rest] = start.sources ?? [];
      let surface: { tabId: number; windowId: number | null };
      try {
        surface = await this.#open(start.strategy, SOURCE_HOME_URLS[first]);
      } catch (error) {
        const reason = errorText(error);
        console.error(`[nmc] Mode B could not open its tab: ${reason}`);
        await this.#hooks.onFinish(refusedRun(start, now, "failed-to-open", reason, pacing));
        return "failed";
      }
      this.#run = {
        ...newRun(start, pacing, now, surface.tabId, surface.windowId, first),
        ...(rest.length > 0 ? { nextSources: rest } : {}),
      };
      try {
        await this.#save();
      } catch (error) {
        // A run that is not stored does not exist: forget it and its surface.
        this.#run = null;
        try {
          if (surface.windowId !== null) await this.#browser.closeWindow(surface.windowId);
          else await this.#browser.closeTab(surface.tabId);
        } catch {
          // Already gone.
        }
        throw error;
      }
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

  /**
   * A new distinct-post count of `source` from `counter`; counts from the
   * other side, or of a feed the run is not scrolling now, are ignored.
   */
  onCount(
    count: number,
    counter: ModeBRun["counter"],
    source: CollectSource = "x",
  ): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || run.counter !== counter || runSource(run) !== source) return;
      run.uniquePostCount = count;
      if (count >= run.target) await this.#finish(run, "target-reached");
      else await this.#save();
    });
  }

  /** A feed response of `source` arrived from `tabId`; only the run's own tab counts. */
  onResponse(
    tabId: number | undefined,
    rateLimited: boolean,
    source: CollectSource = "x",
  ): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || tabId !== run.tabId || runSource(run) !== source) return;
      run.responseCount += 1;
      if (rateLimited) {
        await this.#finish(run, "rate-limited");
        return;
      }
      await this.#save();
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
      if (!run || this.#timer !== null) return;
      this.#schedule(0);
    });
  }

  async #open(
    strategy: ModeBSurface,
    url: string,
  ): Promise<{ tabId: number; windowId: number }> {
    const bounds =
      strategy === "offscreen-window"
        ? await this.#browser.focusedWindowBounds().catch(() => ({}))
        : {};
    return this.#browser.openWindow(surfaceRequest(strategy, bounds, url));
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#step().catch((error: unknown) => {
        console.error(`[nmc] Mode B step failed: ${String(error)}`);
      });
    }, delayMs);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #step(): Promise<void> {
    return this.#enqueue(async () => {
      const run = await this.#load();
      if (!run || this.#timer !== null) return;
      const answer = await this.#ask(run.tabId, runSource(run));
      const { run: next, stop } = applyStep(run, answer.report, Date.now(), this.#limits);
      if (answer.error !== null) next.lastError = answer.error;
      this.#run = next;
      if (stop) {
        await this.#finish(next, stop);
        return;
      }
      this.#schedule(stepDelayMs(this.#random(), next.pacing));
      await this.#save();
    });
  }

  /** One step request; a frozen page never answers, so it is bounded. */
  async #ask(tabId: number, source: CollectSource): Promise<StepAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<StepAnswer>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          report: null,
          error: `no answer to a scroll step within ${this.#limits.stepTimeoutMs / 1000} s`,
        });
      }, this.#limits.stepTimeoutMs);
    });
    const step: ModeBStepMessage =
      source === "x" ? { kind: "mode-b-step" } : { kind: "mode-b-step", source };
    const sent = this.#browser.sendStep(tabId, step).then(
      (answer): StepAnswer =>
        isModeBPageReport(answer)
          ? { report: answer, error: null }
          : { report: null, error: "the page gave no usable answer to a scroll step" },
      (error: unknown): StepAnswer => ({ report: null, error: errorText(error) }),
    );
    try {
      return await Promise.race([sent, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #finish(run: ModeBRun, reason: ModeBStopReason, close = true): Promise<void> {
    this.#cancelTimer();
    const error = reason === "page-unresponsive" ? run.lastError : null;
    const summary = summarize(run, Date.now(), reason, error);
    const legs = [...(run.legs ?? []), legOf(summary)];
    const pending = [...(run.nextSources ?? [])];
    let endedBy: ModeBStopReason = reason;
    let endError: string | null = null;
    const next = pending[0];
    if (next !== undefined && !RUN_ENDING_STOPS.has(reason)) {
      try {
        await this.#nextLeg(run, summary, legs, next, pending.slice(1));
        return;
      } catch (navigateError) {
        // The tab is gone or would not load the next feed: the run ends here.
        endedBy = "failed-to-open";
        endError = errorText(navigateError);
        console.error(`[nmc] Mode B could not open ${next}: ${endError}`);
      }
    }
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
    // Feeds the run never reached end with what ended it, counting nothing.
    for (const source of pending) {
      legs.push({
        source,
        counter: "extension",
        target: run.target,
        uniquePostCount: 0,
        responseCount: 0,
        scrollCount: 0,
        durationMs: 0,
        stopReason: endedBy,
      });
    }
    const final: ModeBRunSummary =
      legs.length > 1
        ? {
            ...summary,
            legs,
            ...(endError !== null && summary.error === undefined ? { error: endError } : {}),
          }
        : summary;
    await this.#hooks.onFinish(final);
  }

  /** Hands the run's tab over to the next feed, as a fresh leg. */
  async #nextLeg(
    run: ModeBRun,
    summary: ModeBRunSummary,
    legs: ModeBLeg[],
    next: CollectSource,
    rest: CollectSource[],
  ): Promise<void> {
    await this.#browser.navigate(run.tabId, SOURCE_HOME_URLS[next]);
    const leg: ModeBStart = {
      strategy: run.strategy,
      target: run.target,
      counter: run.counter,
    };
    this.#run = {
      ...newRun(leg, run.pacing, Date.now(), run.tabId, run.windowId, next),
      ...(rest.length > 0 ? { nextSources: rest } : {}),
      legs,
    };
    await this.#save();
    this.#schedule(this.#limits.firstStepDelayMs);
    await this.#hooks.onLegFinish?.(summary, next);
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
