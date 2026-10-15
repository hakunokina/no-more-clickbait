import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModeBRunSummary } from "@nmc/core";
import type { SessionArea } from "./capture-session.js";
import type { ModeBPageReport } from "./messages.js";
import {
  applyStep,
  isRateLimited,
  loadModeBPacing,
  MODE_B_LIMITS,
  MODE_B_PACING_KEY,
  MODE_B_RUN_KEY,
  ModeBRunner,
  responsePauseMs,
  stepDelayMs,
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
    pacing: "fixed",
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
    awaitingSince: null,
    responseLatencyTotalMs: 0,
    responseLatencyCount: 0,
    lastError: null,
    ...overrides,
  };
}

describe("surfaceRequest", () => {
  it("opens a minimized, unfocused window", () => {
    expect(surfaceRequest("minimized-window", {})).toEqual({
      kind: "window",
      create: { url: X_HOME_URL, state: "minimized", focused: false },
    });
  });

  it("opens an inactive tab in the current window", () => {
    expect(surfaceRequest("background-tab", {})).toEqual({
      kind: "tab",
      create: { url: X_HOME_URL, active: false },
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
      kind: "window",
      create: {
        url: X_HOME_URL,
        state: "normal",
        focused: false,
        width: 480,
        height: 720,
        // 60% of the width stays inside (Chromium wants >= 50% on screen).
        left: 1412,
        top: 230,
      },
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
    expect(request.create).toMatchObject({ left: 992, top: 80 });
  });
});

describe("step pauses", () => {
  it("fixed pacing waits 0.36–0.70 s, a fifth of the first version's 1.8–3.5 s", () => {
    expect(stepDelayMs(0)).toBe(360);
    expect(stepDelayMs(0.5)).toBe(530);
    expect(stepDelayMs(0.9999)).toBeLessThan(700);
  });

  it("response pacing rests 0.4–1.2 s after X answered", () => {
    expect(responsePauseMs(0)).toBe(400);
    expect(responsePauseMs(0.9999)).toBeLessThan(1_200);
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
    openTab: vi.fn((_create: chrome.tabs.CreateProperties) => Promise.resolve({ tabId: 9 })),
    closeWindow: vi.fn((_id: number) => Promise.resolve()),
    closeTab: vi.fn((_id: number) => Promise.resolve()),
    sendStep: vi.fn((_tabId: number, _message: unknown) => Promise.resolve(answer())),
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
  const fixed = { loadPacing: () => Promise.resolve("fixed" as const) };

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
    expect(browser.sendStep).toHaveBeenCalledWith(7, { kind: "mode-b-step", action: "jump" });
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
        pacing: "fixed",
        // 2 steps over the 0.36 s since the first one.
        scrollsPerMinute: 333.3,
        stepsWithNewResponse: 0,
      },
    ]);
    // No step after the run ended.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.sendStep).toHaveBeenCalledTimes(2);
  });

  it("closes a background tab, not a window", async () => {
    const browser = fakeBrowser(() => page({ page: "login" }));
    const runner = new ModeBRunner(browser, area, hooks, fixed);
    await runner.start({ ...start, strategy: "background-tab" });
    expect(browser.openTab).toHaveBeenCalledWith({ url: X_HOME_URL, active: false });
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.closeTab).toHaveBeenCalledWith(9);
    expect(browser.closeWindow).not.toHaveBeenCalled();
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
      pacing: "fixed",
      error: reason,
    });
    expect(await runner.current()).toBeNull();
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

  it("response pacing: waits for X's answer, rests, then jumps again", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, {
      loadPacing: () => Promise.resolve("response"),
      random: () => 0,
    });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.sendStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await runner.onResponse(7, false);
    await vi.advanceTimersByTimeAsync(responsePauseMs(0) - 1);
    expect(browser.sendStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.sendStep).toHaveBeenLastCalledWith(7, {
      kind: "mode-b-step",
      action: "jump",
    });
    expect(await runner.current()).toMatchObject({
      responseLatencyTotalMs: 300,
      responseLatencyCount: 1,
    });
    await runner.stop();
    expect(finished[0]).toMatchObject({ pacing: "response", avgResponseLatencyMs: 300 });
  });

  it("response pacing: nudges once when X ignores a jump, then jumps again", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks, {
      loadPacing: () => Promise.resolve("response"),
      random: () => 0,
    });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.responseWaitMs);
    expect(browser.sendStep).toHaveBeenLastCalledWith(7, {
      kind: "mode-b-step",
      action: "nudge",
    });
    await vi.advanceTimersByTimeAsync(responsePauseMs(0));
    expect(browser.sendStep.mock.calls.map(([, message]) => message.action)).toEqual([
      "jump",
      "nudge",
      "jump",
    ]);
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

describe("loadModeBPacing", () => {
  it("reads the stored choice and falls back to response pacing", async () => {
    const area = (value: unknown) => ({
      get: () => Promise.resolve({ [MODE_B_PACING_KEY]: value }),
    });
    await expect(loadModeBPacing(area("fixed") as never)).resolves.toBe("fixed");
    await expect(loadModeBPacing(area("warp") as never)).resolves.toBe("response");
    await expect(
      loadModeBPacing({ get: () => Promise.reject(new Error("gone")) } as never),
    ).resolves.toBe("response");
  });
});
