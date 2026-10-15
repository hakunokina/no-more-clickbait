import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModeBRunSummary } from "@nmc/core";
import type { SessionArea } from "./capture-session.js";
import type { ModeBPageReport } from "./messages.js";
import {
  applyStep,
  isRateLimited,
  MODE_B_LIMITS,
  MODE_B_RUN_KEY,
  ModeBRunner,
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
    countAtLastProgress: 0,
    stepsWithoutProgress: 0,
    unansweredSteps: 0,
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

  it("pushes a small unfocused window past the focused window's bottom-right corner", () => {
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
        left: 1660,
        top: 910,
      },
    });
  });
});

describe("stepDelayMs", () => {
  it("stays between 1.8 s and 3.5 s", () => {
    expect(stepDelayMs(0)).toBe(1_800);
    expect(stepDelayMs(0.5)).toBe(2_650);
    expect(stepDelayMs(0.9999)).toBeLessThan(3_500);
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
      countAtLastProgress: 20,
      stepsWithoutProgress: 0,
    });
  });

  it("stops as stalled after K steps in a row without a new post", () => {
    let current = run({ uniquePostCount: 20, countAtLastProgress: 20 });
    for (let i = 1; i < MODE_B_LIMITS.stallSteps; i += 1) {
      const result = applyStep(current, page(), i * 1_000);
      expect(result.stop).toBeNull();
      current = result.run;
    }
    expect(applyStep(current, page(), 60_000).stop).toBe("stalled");
    // A new post in between resets the streak.
    expect(applyStep({ ...current, uniquePostCount: 21 }, page(), 60_000).stop).toBeNull();
  });

  it("stops at the time limit", () => {
    expect(applyStep(run(), page(), MODE_B_LIMITS.maxDurationMs).stop).toBe("timeout");
  });

  it("stops on login, error and away pages", () => {
    expect(applyStep(run(), page({ page: "login" }), 1).stop).toBe("not-logged-in");
    expect(applyStep(run(), page({ page: "error" }), 1).stop).toBe("error-page");
    expect(applyStep(run(), page({ page: "away" }), 1).stop).toBe("navigated-away");
  });

  it("gives up when the page stops answering", () => {
    let current = run({ uniquePostCount: 1 });
    for (let i = 1; i < MODE_B_LIMITS.maxUnansweredSteps; i += 1) {
      const result = applyStep(current, null, i);
      expect(result.stop).toBeNull();
      current = { ...result.run, uniquePostCount: result.run.uniquePostCount + 1 };
    }
    expect(applyStep(current, null, 99).stop).toBe("page-unresponsive");
    expect(applyStep(current, page(), 99).run.unansweredSteps).toBe(0);
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
    const runner = new ModeBRunner(browser, area, hooks, { random: () => 0 });
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
        endedAt: "2026-01-01T10:00:07.800Z",
        durationMs: 7_800,
        scrollCount: 2,
        scrollMovedCount: 2,
        hiddenStepCount: 2,
        responseCount: 1,
        uniquePostCount: 50,
        stopReason: "target-reached",
      },
    ]);
    // No step after the run ended.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.sendStep).toHaveBeenCalledTimes(2);
  });

  it("closes a background tab, not a window", async () => {
    const browser = fakeBrowser(() => page({ page: "login" }));
    const runner = new ModeBRunner(browser, area, hooks);
    await runner.start({ ...start, strategy: "background-tab" });
    expect(browser.openTab).toHaveBeenCalledWith({ url: X_HOME_URL, active: false });
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    expect(browser.closeTab).toHaveBeenCalledWith(9);
    expect(browser.closeWindow).not.toHaveBeenCalled();
    expect(finished[0]?.stopReason).toBe("not-logged-in");
  });

  it("measures the focused window for the off-screen strategy", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks);
    await runner.start({ ...start, strategy: "offscreen-window" });
    expect(browser.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ left: 960, top: 760, focused: false, state: "normal" }),
    );
  });

  it("refuses a second run while one is going", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks);
    await runner.start(start);
    await expect(runner.start(start)).resolves.toBe("busy");
  });

  it("records a run whose surface could not be opened", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = fakeBrowser();
    browser.openWindow.mockRejectedValueOnce(new Error("nope"));
    const runner = new ModeBRunner(browser, area, hooks);
    await expect(runner.start(start)).resolves.toBe("failed");
    expect(finished[0]).toMatchObject({ stopReason: "failed-to-open", scrollCount: 0 });
    expect(await runner.current()).toBeNull();
  });

  it("ignores counts from the other counter and responses from other tabs", async () => {
    const runner = new ModeBRunner(fakeBrowser(), area, hooks);
    await runner.start(start);
    await runner.onCount(500, "host");
    await runner.onResponse(99, true);
    await runner.onResponse(undefined, false);
    expect(await runner.current()).toMatchObject({ uniquePostCount: 0, responseCount: 0 });
    expect(finished).toEqual([]);
  });

  it("stops when the run's tab reports a rate limit", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks);
    await runner.start(start);
    await runner.onResponse(7, true);
    expect(finished[0]).toMatchObject({ stopReason: "rate-limited", responseCount: 1 });
    expect(browser.closeWindow).toHaveBeenCalledWith(3);
  });

  it("does not try to close a tab the user already closed", async () => {
    const browser = fakeBrowser();
    const runner = new ModeBRunner(browser, area, hooks);
    await runner.start(start);
    await runner.onTabRemoved(7);
    expect(finished[0]?.stopReason).toBe("tab-closed");
    expect(browser.closeWindow).not.toHaveBeenCalled();
  });

  it("treats a step the page never answers as unanswered", async () => {
    const browser = fakeBrowser();
    browser.sendStep.mockImplementation(() => new Promise(() => {}));
    const runner = new ModeBRunner(browser, area, hooks, { random: () => 0 });
    await runner.start(start);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.firstStepDelayMs);
    await vi.advanceTimersByTimeAsync(MODE_B_LIMITS.stepTimeoutMs);
    expect(await runner.current()).toMatchObject({ unansweredSteps: 1, scrollCount: 0 });
  });

  it("resumes a stored run after a service-worker restart", async () => {
    const browser = fakeBrowser();
    await new ModeBRunner(browser, area, hooks).start(start);
    // The worker died: a new runner over the same session area takes over.
    const restarted = new ModeBRunner(browser, area, hooks);
    await restarted.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.sendStep).toHaveBeenCalledTimes(1);
    await restarted.stop();
    expect(finished[0]).toMatchObject({ stopReason: "cancelled", scrollCount: 1 });
  });

  it("drops a corrupt stored run instead of resuming it", async () => {
    area.data.set(MODE_B_RUN_KEY, { strategy: "teleport", tabId: 1 });
    const runner = new ModeBRunner(fakeBrowser(), area, hooks);
    expect(await runner.current()).toBeNull();
  });
});
