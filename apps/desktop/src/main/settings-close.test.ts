import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlushBeforeClose, requestFlush, type FlushChannel } from "./settings-close.js";

describe("requestFlush", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function channel(answer: boolean): FlushChannel & { listeners: number } {
    let listener: (() => void) | null = null;
    return {
      listeners: 0,
      request() {
        if (answer) setTimeout(() => listener?.(), 10);
      },
      onDone(next) {
        listener = next;
        this.listeners += 1;
        return () => {
          listener = null;
          this.listeners -= 1;
        };
      },
    };
  }

  it("resolves when the page says it saved", async () => {
    const page = channel(true);
    const done = requestFlush(page, 2_000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(done).resolves.toBe("flushed");
    expect(page.listeners).toBe(0);
  });

  it("gives up on a page that does not answer", async () => {
    const page = channel(false);
    const done = requestFlush(page, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe("timed-out");
    expect(page.listeners).toBe(0);
  });
});

describe("FlushBeforeClose", () => {
  it("holds the close until the page saved, then closes and lets a held quit go on", async () => {
    let finishFlush: () => void = () => undefined;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve;
        }),
    );
    const close = vi.fn();
    const quit = vi.fn();
    const gate = new FlushBeforeClose(flush, close);

    const closeEvent = { preventDefault: vi.fn() };
    gate.hold(closeEvent);
    const quitEvent = { preventDefault: vi.fn() };
    gate.hold(quitEvent, quit);
    expect(closeEvent.preventDefault).toHaveBeenCalled();
    expect(quitEvent.preventDefault).toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    finishFlush();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(quit).toHaveBeenCalledTimes(1);
    expect(gate.flushed).toBe(true);

    // The real close that follows is not held again.
    const again = { preventDefault: vi.fn() };
    gate.hold(again);
    expect(again.preventDefault).not.toHaveBeenCalled();
  });

  it("closes even when saving failed", async () => {
    const close = vi.fn();
    const gate = new FlushBeforeClose(() => Promise.reject(new Error("gone")), close);
    gate.hold({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
