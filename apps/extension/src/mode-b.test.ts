import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModeBRunSummary } from "@nmc/core";
import type { SessionArea } from "./capture-session.js";
import type { ModeBPageReport } from "./messages.js";
import {
  applyStep,
  describeStopReason,
  INSTAGRAM_HOME_URL,
  isRateLimited,
  loadModeBPacing,
  LEGACY_MODE_B_PACING_KEY,
  MODE_B_LIMITS,
  MODE_B_RUN_KEY,
  ModeBRunner,
  removeLegacyModeBPacing,
  runStopReason,
  stepDelayMs,
  summarize,
  surfaceRequest,
  X_HOME_URL,
  type ModeBBrowser,
  type ModeBRun,
} from "./mode-b.js";

const page = (overrides: Partial<ModeBPageReport> = {}): ModeBPageReport => ({
  kind: "mode-b-page",
  page: "timeline",
  hidden: true,
  scrolled: true,
  ...overrides,
});

function run(overrides: Partial<ModeBRun> = {}): ModeBRun {
  return {
    strategy: "minimized-window",
    pacing: "normal",
    counter: "extension",
    target: 100,
    startedAt: 0,
    tabId: 7,
    windowId: 3,
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
    ...overrides,
  };
}

describe("surfaceRequest", () => {
  it("opens a minimized, unfocused window", () => {
    expect(surfaceRequest("minimized-window", {})).toEqual({
      url: X_HOME_URL,
      state: "minimized",
      focused: false,
    });
  });

  it("hangs a small unfocused window 40% off the focused window's right edge", () => {
    const request = surfaceRequest("offscreen-window", {
      left: 100,
      top: 50,
      width: 1600,
      height: 900,
    });
    expect(request).toEqual({
      url: X_HOME_URL,
      state: "normal",
      focused: false,
      width: 480,
      height: 720,
      // 60% of the width stays inside (Chromium wants >= 50% on screen).
      left: 1412,
      top: 230,
    });
  });

  it("ignores a minimized focused window's bounds", () => {
    const request = surfaceRequest("offscreen-window", {
      left: -32_000,
      top: -32_000,
      width: 160,
      height: 28,
      state: "minimized",
    });
    expect(request).toMatchObject({ left: 992, top: 80 });
  });
});

describe("step pauses", () => {
  it("normal pacing waits 0.36–0.70 s, a fifth of the first version's 1.8–3.5 s", () => {
    expect(stepDelayMs(0)).toBe(360);
    expect(stepDelayMs(0.5, "normal")).toBe(530);
    expect(stepDelayMs(0.9999, "normal")).toBeLessThan(700);
  });

  it("fast pacing waits half as long, 0.18–0.35 s", () => {
    expect(stepDelayMs(0, "fast")).toBe(180);
    expect(stepDelayMs(0.5, "fast")).toBe(265);
    expect(stepDelayMs(0.9999, "fast")).toBeLessThan(350);
  });
});

describe("isRateLimited", () => {
  it("spots HTTP 429 and GraphQL error code 88", () => {
    expect(isRateLimited(429, undefined)).toBe(true);
    expect(
      isRateLimited(200, { errors: [{ code: 88, message: "Rate limit exceeded." }] }),
    ).toBe(true);
    expect(isRateLimited(200, { errors: [{ code: 37 }] })).toBe(false);
    expect(isRateLimited(200, { data: {} })).toBe(false);
    expect(isRateLimited(undefined, "not an object")).toBe(false);
  });
});

describe("applyStep", () => {
  it("counts scrolls, moved scrolls and hidden steps", () => {
    const { run: next, stop } = applyStep(
      run({ uniquePostCount: 20 }),
      page({ scrolled: false }),
      1_000,
    );
    expect(stop).toBeNull();
    expect(next).toMatchObject({
      scrollCount: 1,
      scrollMovedCount: 0,
      hiddenStepCount: 1,
      firstStepAt: 1_000,
      countAtLastProgress: 20,
      lastProgressAt: 1_000,
    });
  });

  it("stops as stalled after a stretch of time without a new post, however many steps", () => {
    // The first version's 8 steps of ~2.65 s.
    expect(MODE_B_LIMITS.stallMs).toBe(21_200);
    let current = run({ uniquePostCount: 20, countAtLastProgress: 20, lastProgressAt: 1_000 });
    for (let t = 1_100; t < 1_000 + MODE_B_LIMITS.stallMs; t += 500) {
      const result = applyStep(current, page(), t);
      expect(result.stop).toBeNull();
      current = result.run;
    }
    expect(current.scrollCount).toBeGreaterThan(40);
    expect(applyStep(current, page(), 1_000 + MODE_B_LIMITS.stallMs).stop).toBe("stalled");
    // A new post in between restarts the clock.
    const fresh = applyStep({ ...current, uniquePostCount: 21 }, page(), 60_000);
    expect(fresh.stop).toBeNull();
    expect(fresh.run.lastProgressAt).toBe(60_000);
  });

  it("counts the steps that brought a response after the page's first one", () => {
    let current = run({ responseCount: 1 }); // the initial load, before any step
    current = applyStep(current, page(), 1_000).run;
    expect(current.stepsWithNewResponse).toBe(0);
    current = applyStep(current, page(), 2_000).run; // nothing new
    current = applyStep({ ...current, responseCount: 3 }, page(), 3_000).run;
    current = applyStep({ ...current, responseCount: 4 }, page(), 4_000).run;
    expect(current.stepsWithNewResponse).toBe(2);
    // The last step's response arrives after it: the summary still counts it.
    const ended = { ...current, responseCount: 5 };
    expect(ended.stepsWithNewResponse).toBe(2);
    expect(summarize(ended, 5_000, "target-reached").stepsWithNewResponse).toBe(3);
    // Only the page's initial load: nothing a step brought.
    expect(summarize(run({ responseCount: 1 }), 5_000, "stalled").stepsWithNewResponse).toBe(0);
  });

  it("stops at the time limit", () => {
    expect(applyStep(run(), page(), MODE_B_LIMITS.maxDurationMs).stop).toBe("timeout");
  });

  it("stops on login, error and away pages", () => {
    expect(applyStep(run(), page({ page: "login" }), 1).stop).toBe("not-logged-in");
    expect(applyStep(run(), page({ page: "error" }), 1).stop).toBe("error-page");
    expect(applyStep(run(), page({ page: "away" }), 1).stop).toBe("navigated-away");
  });

  it("gives up when the page has not answered for a while", () => {
    let current = applyStep(run(), null, 1_000).run;
    expect(current.unansweredSince).toBe(1_000);
    current = applyStep(current, null, 1_000 + MODE_B_LIMITS.maxUnansweredMs - 1).run;
    expect(applyStep(current, null, 1_000 + MODE_B_LIMITS.maxUnansweredMs).stop).toBe(
      "page-unresponsive",
    );
    expect(applyStep(current, page(), 5_000).run.unansweredSince).toBeNull();
  });
});

function fakeArea(): SessionArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {}),
    set: (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

function fakeBrowser(answer: () => unknown = () => page()) {
  const browser = {
    focusedWindowBounds: vi.fn(() =>
      Promise.resolve({ left: 0, top: 0, width: 1000, height: 800 }),
    ),
    openWindow: vi.fn((_create: chrome.windows.CreateData) =>
      Promise.resolve({ windowId: 3, tabId: 7 }),
    ),
    closeWindow: vi.fn((_id: number) => Promise.resolve()),
    sendStep: vi.fn((_tabId: number, _message: unknown) => Promise.resolve(answer())),
    navigate: vi.fn((_tabId: number, _url: string) => Promise.resolve()),
  } satisfies ModeBBrowser;
  return browser;
}

describe("ModeBRunner", () => {
  let area: ReturnType<typeof fakeArea>;
  let finished: ModeBRunSummary[];
  const hooks = {
    onFinish: (summary: ModeBRunSummary) => {
      finished.push(summary);
      return Promise.resolve();
    },
  };
  const start = { strategy: "minimized-window", target: 50, counter: "extension" } as const;
  const fixed = { loadPacing: () => Promise.resolve("normal" as const) };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    area = fakeArea();
    finished = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the surface, steps after the first delay and stops at the target", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, { ...fixed, random: () => 0 });
    await expect(runner.start(start)).resolves.toBe("started");
    expect(browser.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ state: "minimized", url: X_HOME_URL }),
    );
    expect(area.data.get(MODE_B_RUN_KEY)).toMatchObject({ tabId: 7, windowId: 3 });

    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs - 1);
    expect(browser.sendStep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.sendStep).toHaveBeenCalledWith(7, { kind: "mode-b-step" });
    await runner.onResponse(7, false);
    await runner.onCount(30, "extension");
    await vi.advanceTimersByTimeAsync(stepDelayMs(0));
    expect(browser.sendStep).toHaveBeenCalledTimes(2);

    await runner.onCount(50, "extension");
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    expect(area.data.has(MODE_B_RUN_KEY)).toBe(false);
    expect(finished).toEqual([
      {
        strategy: "minimized-window",
        counter: "extension",
        target: 50,
        startedAt: "2026-01-01T10:00:00.000Z",
        endedAt: "2026-01-01T10:00:06.360Z",
        durationMs: 6_360,
        scrollCount: 2,
        scrollMovedCount: 2,
        hiddenStepCount: 2,
        responseCount: 1,
        uniquePostCount: 50,
        stopReason: "target-reached",
        pacing: "normal",
        // 2 steps over the 0.36 s since the first one.
        scrollsPerMinute: 333.3,
        stepsWithNewResponse: 0,
      },
    ]);
    // No step after the run ended.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.sendStep).toHaveBeenCalledTimes(2);
  });

  it("closes its window when the page is not logged in", async () => {
    const browser = fakeBrowser(() => page({ page: "login" }));
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    expect(finished[0]?.stopReason).toBe("not-logged-in");
  });

  it("measures the focused window for the off-screen strategy", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start({ ...start, strategy: "offscreen-window" });
    expect(browser.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ left: 712, top: 80, focused: false, state: "normal" }),
    );
  });

  it("refuses a second run while one is going", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks, fixed);
    await runner.start(start);
    await expect(runner.start(start)).resolves.toBe("busy");
  });

  it("records a run whose surface could not be opened, with the browser's reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = fakeBrowser();
    const reason =
      "Invalid value for bounds. Bounds must be at least 50% within visible screen space.";
    browser.openWindow.mockRejectedValueOnce(new Error(reason));
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await expect(runner.start({ ...start, strategy: "offscreen-window" })).resolves.toBe(
      "failed",
    );
    expect(finished[0]).toMatchObject({
      stopReason: "failed-to-open",
      scrollCount: 0,
      pacing: "normal",
      error: reason,
    });
    expect(await runner.current()).toBeNull();
  });

  it("forgets a start whose run could not be stored and closes its window", async () => {
    const browser = fakeBrowser();
    area.set = () => Promise.reject(new Error("quota"));
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await expect(runner.start(start)).rejects.toThrow("quota");
    expect(await runner.current()).toBeNull();
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    // No step of the forgotten run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.sendStep).not.toHaveBeenCalled();
  });

  it("ignores counts from the other counter and responses from other tabs", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks, fixed);
    await runner.start(start);
    await runner.onCount(500, "host");
    await runner.onResponse(99, true);
    await runner.onResponse(undefined, false);
    expect(await runner.current()).toMatchObject({ uniquePostCount: 0, responseCount: 0 });
    expect(finished).toEqual([]);
  });

  it("stops when the run's tab reports a rate limit", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(start);
    await runner.onResponse(7, true);
    expect(finished[0]).toMatchObject({ stopReason: "rate-limited", responseCount: 1 });
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
  });

  it("does not count the rate-limit answer as a step's new response", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, { ...fixed, random: () => 0 });
    await runner.start(start);
    await runner.onResponse(7, false); // the page's first load
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await runner.onResponse(7, false); // brought by the first step
    await vi.advanceTimersByTimeAsync(stepDelayMs(0));
    await runner.onResponse(7, true); // the second step's answer: a 429
    expect(finished[0]).toMatchObject({
      stopReason: "rate-limited",
      responseCount: 3,
      stepsWithNewResponse: 1,
    });
  });

  it("a rate limit right after the first load counts no step's response", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks, fixed);
    await runner.start(start);
    await runner.onResponse(7, false);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await runner.onResponse(7, true);
    expect(finished[0]).toMatchObject({ responseCount: 2, stepsWithNewResponse: 0 });
  });

  it("ends the run when the native host is unreachable, with the browser's words", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(start);
    await runner.stop("host-unreachable", "Specified native messaging host not found.");
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    expect(finished[0]).toMatchObject({
      stopReason: "host-unreachable",
      error: "Specified native messaging host not found.",
    });
    expect(describeStopReason("host-unreachable")).toBe(
      "could not connect to the desktop app — is its native host installed?",
    );
  });

  it("does not try to close a tab the user already closed", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(start);
    await runner.onTabRemoved(7);
    expect(finished[0]?.stopReason).toBe("tab-closed");
    expect(browser.closeWindow).not.toHaveBeenCalled();
  });

  it("treats a step the page never answers as unanswered", async () => {
    const browser = fakeBrowser();
    browser.sendStep.mockImplementation(() => new Promise(() => {}));
    const runner = new ModeBRunner(browser, area, hooks, { ...fixed, random: () => 0 });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.stepTimeoutMs);
    expect(await runner.current()).toMatchObject({
      unansweredSince: Date.now(),
      scrollCount: 0,
      lastError: "no answer to a scroll step within 5 s",
    });
  });

  it("treats a malformed page answer as unanswered, saying so", async () => {
    const browser = fakeBrowser(() => ({ kind: "mode-b-page", page: "bogus", hidden: true }));
    const runner = new ModeBRunner(browser, area, hooks, { ...fixed, random: () => 0 });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(await runner.current()).toMatchObject({
      unansweredSince: Date.now(),
      scrollCount: 0,
      lastError: "the page gave no usable answer to a scroll step",
    });
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.maxUnansweredMs + stepDelayMs(0));
    expect(finished[0]).toMatchObject({
      stopReason: "page-unresponsive",
      error: "the page gave no usable answer to a scroll step",
    });
  });

  it("ends a run whose page never answers, saying why", async () => {
    const browser = fakeBrowser();
    browser.sendStep.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    const runner = new ModeBRunner(browser, area, hooks, { ...fixed, random: () => 0 });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(
      MODE_B_LIMITS.firstStepDelayMs + MODE_B_LIMITS.maxUnansweredMs + stepDelayMs(0),
    );
    expect(finished[0]).toMatchObject({
      stopReason: "page-unresponsive",
      responseCount: 0,
      error: "Could not establish connection. Receiving end does not exist.",
    });
    // Unanswered steps still came fast: the limit is time, not a step count.
    expect(browser.sendStep.mock.calls.length).toBeGreaterThan(20);
  });

  it("fast pacing jumps twice as often, but gives up after the same stall time", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, {
      loadPacing: () => Promise.resolve("fast"),
      random: () => 0,
    });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.sendStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(stepDelayMs(0, "fast"));
    expect(browser.sendStep).toHaveBeenCalledTimes(2);
    expect(stepDelayMs(0, "fast")).toBeLessThan(stepDelayMs(0, "normal"));
    // The stall is noticed at the first step past the window.
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.stallMs - stepDelayMs(0, "fast"));
    expect(finished).toEqual([]);
    await vi.advanceTimersByTimeAsync(stepDelayMs(0, "fast"));
    expect(finished[0]).toMatchObject({ stopReason: "stalled", pacing: "fast" });
  });

  it("resumes a stored run after a service-worker restart", async () => {
    const browser = fakeBrowser();
    await new ModeBRunner(browser, area, hooks, fixed).start(start);
    // The worker died: a new runner over the same session area takes over.
    const restarted = new ModeBRunner(browser, area, hooks, fixed);
    await restarted.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.sendStep).toHaveBeenCalledTimes(1);
    await restarted.stop();
    expect(finished[0]).toMatchObject({ stopReason: "cancelled", scrollCount: 1 });
  });

  it("drops a corrupt stored run instead of resuming it", async () => {
    area.data.set(MODE_B_RUN_KEY, { strategy: "teleport", tabId: 1 });
    const runner = new ModeBRunner(fakeBrowser(), area, hooks, fixed);
    expect(await runner.current()).toBeNull();
  });
});

describe("ModeBRunner over several feeds", () => {
  let area: ReturnType<typeof fakeArea>;
  let finished: ModeBRunSummary[];
  let legEnds: [ModeBRunSummary, string][];
  const hooks = {
    onFinish: (summary: ModeBRunSummary) => {
      finished.push(summary);
      return Promise.resolve();
    },
    onLegFinish: (summary: ModeBRunSummary, next: string) => {
      legEnds.push([summary, next]);
      return Promise.resolve();
    },
  };
  const both = {
    strategy: "minimized-window",
    target: 50,
    counter: "host",
    sources: ["x", "instagram"],
  } as const;
  const fixed = { loadPacing: () => Promise.resolve("normal" as const), random: () => 0 };
  const legsOfRun = (summary: ModeBRunSummary | undefined) =>
    summary?.legs?.map((leg) => [leg.source, leg.uniquePostCount, leg.stopReason]);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    area = fakeArea();
    finished = [];
    legEnds = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scrolls X, then Instagram in the same window; each feed stops at its own target", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    expect(browser.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: X_HOME_URL }),
    );
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.sendStep).toHaveBeenLastCalledWith(7, { kind: "mode-b-step" });

    // A feed's count means nothing while the other one is scrolled.
    await runner.onCount(50, "extension", "instagram");
    expect(browser.navigate).not.toHaveBeenCalled();
    await runner.onCount(50, "host");
    expect(browser.navigate).toHaveBeenCalledWith(7, INSTAGRAM_HOME_URL);
    expect(browser.closeWindow).not.toHaveBeenCalled();
    expect(legEnds.map(([leg, next]) => [leg.source, leg.stopReason, next])).toEqual([
      [undefined, "target-reached", "instagram"],
    ]);
    expect(await runner.current()).toMatchObject({
      source: "instagram",
      counter: "extension",
      uniquePostCount: 0,
      tabId: 7,
      windowId: 3,
    });

    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.sendStep).toHaveBeenLastCalledWith(7, {
      kind: "mode-b-step",
      source: "instagram",
    });
    await runner.onCount(60, "host");
    await runner.onResponse(7, false, "instagram");
    await runner.onCount(50, "extension", "instagram");
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      source: "instagram",
      counter: "extension",
      uniquePostCount: 50,
      responseCount: 1,
      stopReason: "target-reached",
    });
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 50, "target-reached"],
      ["instagram", 50, "target-reached"],
    ]);
    expect(runStopReason(finished[0] as ModeBRunSummary)).toBe("target-reached");
  });

  it("moves on to Instagram when X is not logged in, and says so", async () => {
    let calls = 0;
    const browser = fakeBrowser(() =>
      page({ page: (calls += 1) === 1 ? "login" : "timeline" }),
    );
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.navigate).toHaveBeenCalledWith(7, INSTAGRAM_HOME_URL);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await runner.onCount(50, "extension", "instagram");
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 0, "not-logged-in"],
      ["instagram", 50, "target-reached"],
    ]);
    expect(runStopReason(finished[0] as ModeBRunSummary)).toBe("not-logged-in");
  });

  it("a cancel ends both feeds; the one never reached counts nothing", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    await runner.onCount(20, "host");
    await runner.stop("cancelled");
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 20, "cancelled"],
      ["instagram", 0, "cancelled"],
    ]);
    expect(runStopReason(finished[0] as ModeBRunSummary)).toBe("cancelled");
  });

  it("a cancel during Instagram ends the run as cancelled", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    await runner.onCount(50, "host");
    await runner.onCount(10, "extension", "instagram");
    await runner.stop("cancelled");
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 50, "target-reached"],
      ["instagram", 10, "cancelled"],
    ]);
    expect(runStopReason(finished[0] as ModeBRunSummary)).toBe("cancelled");
  });

  it("opens Instagram straight away when it is the only feed", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start({ ...both, sources: ["instagram"] });
    expect(browser.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: INSTAGRAM_HOME_URL }),
    );
    await runner.onCount(50, "extension", "instagram");
    expect(finished[0]).toMatchObject({ source: "instagram", stopReason: "target-reached" });
    expect(finished[0]?.legs).toBeUndefined();
  });

  it("ends the run when the window will not load the next feed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = fakeBrowser();
    browser.navigate.mockRejectedValueOnce(new Error("No tab with id: 7."));
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    await runner.onCount(50, "host");
    expect(await runner.current()).toBeNull();
    expect(finished[0]).toMatchObject({ error: "No tab with id: 7." });
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 50, "target-reached"],
      ["instagram", 0, "failed-to-open"],
    ]);
  });

  it("an unreachable host ends the run, Instagram included", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks, fixed);
    await runner.start(both);
    await runner.stop("host-unreachable");
    expect(legsOfRun(finished[0])).toEqual([
      ["x", 0, "host-unreachable"],
      ["instagram", 0, "host-unreachable"],
    ]);
    expect(runStopReason(finished[0] as ModeBRunSummary)).toBe("host-unreachable");
  });

  it("resumes the Instagram leg after a service-worker restart", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start(both);
    await runner.onCount(50, "host");
    const restarted = new ModeBRunner(browser, area, hooks, fixed);
    expect(await restarted.current()).toMatchObject({ source: "instagram" });
    await restarted.onCount(50, "extension", "instagram");
    expect(legsOfRun(finished[0])).toHaveLength(2);
  });
});

describe("loadModeBPacing", () => {
  it("reads Settings", async () => {
    await expect(loadModeBPacing(() => Promise.resolve({ modeBPacing: "fast" }))).resolves.toBe(
      "fast",
    );
  });

  it("falls back to normal pacing when Settings cannot be read", async () => {
    await expect(loadModeBPacing(() => Promise.reject(new Error("gone")))).resolves.toBe(
      "normal",
    );
  });
});

describe("removeLegacyModeBPacing", () => {
  it("drops the pacing trial's old key, and shrugs off a failure", async () => {
    const storage = { remove: vi.fn(() => Promise.resolve()) };
    await removeLegacyModeBPacing(storage as never);
    expect(storage.remove).toHaveBeenCalledWith(LEGACY_MODE_B_PACING_KEY);
    const failing = { remove: () => Promise.reject(new Error("gone")) };
    await expect(removeLegacyModeBPacing(failing as never)).resolves.toBeUndefined();
  });
});
