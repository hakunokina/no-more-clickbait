import { describe, expect, it, vi } from "vitest";
import { classifyPage, scrollStep, type PageFacts } from "./mode-b-page.js";

const facts = (overrides: Partial<PageFacts> = {}): PageFacts => ({
  pathname: "/home",
  hasLoginControl: false,
  hasRetryButton: false,
  cellCount: 12,
  ...overrides,
});

describe("classifyPage", () => {
  it("sees a loaded or still-loading home timeline", () => {
    expect(classifyPage(facts())).toBe("timeline");
    expect(classifyPage(facts({ cellCount: 0 }))).toBe("loading");
  });

  it("sees the logged-out landing and login flows", () => {
    expect(classifyPage(facts({ pathname: "/" }))).toBe("login");
    expect(classifyPage(facts({ pathname: "/login" }))).toBe("login");
    expect(classifyPage(facts({ pathname: "/i/flow/login" }))).toBe("login");
    expect(classifyPage(facts({ hasLoginControl: true }))).toBe("login");
  });

  it("sees X's retry (error / rate-limit) state", () => {
    expect(classifyPage(facts({ hasRetryButton: true }))).toBe("error");
  });

  it("sees a tab that left the home timeline", () => {
    expect(classifyPage(facts({ pathname: "/someone/status/1" }))).toBe("away");
    expect(classifyPage(facts({ pathname: "/loginhelp" }))).toBe("away");
  });
});

function fakePage(scrollHeight: number) {
  const win = {
    scrollY: 0,
    innerHeight: 800,
    scrollTo: vi.fn((_x: number, y: number) => {
      win.scrollY = Math.min(y, scrollHeight - 800);
    }),
    scrollBy: vi.fn((_x: number, dy: number) => {
      win.scrollY = Math.max(0, win.scrollY + dy);
    }),
    dispatchEvent: vi.fn(() => true),
  };
  const lastCell = { scrollIntoView: vi.fn() };
  const doc = {
    hidden: true,
    location: { pathname: "/home" },
    body: null,
    scrollingElement: { scrollHeight },
    documentElement: { scrollHeight },
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector.includes("cellInnerDiv") ? [{}, lastCell] : [],
  };
  return { win, doc, lastCell };
}

describe("scrollStep", () => {
  it("jumps to the bottom of the timeline and fires a scroll event", () => {
    const { win, doc, lastCell } = fakePage(10_000);
    const report = scrollStep(doc as never, win as never, "jump");
    expect(win.scrollTo).toHaveBeenCalledWith(0, 10_000);
    expect(lastCell.scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(win.dispatchEvent).toHaveBeenCalled();
    expect(report).toEqual({
      kind: "mode-b-page",
      page: "timeline",
      hidden: true,
      scrolled: true,
    });
  });

  it("nudges half a viewport up, then back to the bottom", () => {
    const { win, doc } = fakePage(10_000);
    win.scrollY = 9_200;
    const report = scrollStep(doc as never, win as never, "nudge");
    expect(win.scrollBy).toHaveBeenCalledWith(0, -400);
    expect(win.scrollY).toBe(9_200);
    // Nothing new loaded: the position ends where it started.
    expect(report.scrolled).toBe(false);
  });
});
