import { describe, expect, it, vi } from "vitest";
import { answerModeBStep, classifyPage, scrollStep, type PageFacts } from "./mode-b-page.js";

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
    const report = scrollStep(doc as never, win as never);
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
});

describe("answerModeBStep (the content script's listener)", () => {
  const ours = { id: "nmc" };

  it("ignores a step from another extension, or from no extension at all", () => {
    const { win, doc } = fakePage(10_000);
    for (const sender of [{ id: "someone-else" }, {}]) {
      expect(
        answerModeBStep({ kind: "mode-b-step" }, sender, "nmc", doc as never, win as never),
      ).toBeUndefined();
    }
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores messages that are not a well-formed step", () => {
    const { win, doc } = fakePage(10_000);
    for (const message of [
      null,
      "mode-b-step",
      { kind: "timeline-capture" },
      { kind: "mode-b-step", source: "reddit" },
    ]) {
      expect(answerModeBStep(message, ours, "nmc", doc as never, win as never)).toBeUndefined();
    }
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls on its own step and answers away to Instagram's", () => {
    const { win, doc } = fakePage(10_000);
    expect(
      answerModeBStep(
        { kind: "mode-b-step", source: "instagram" },
        ours,
        "nmc",
        doc as never,
        win as never,
      ),
    ).toEqual({ kind: "mode-b-page", page: "away", hidden: true, scrolled: false });
    expect(win.scrollTo).not.toHaveBeenCalled();
    expect(
      answerModeBStep({ kind: "mode-b-step" }, ours, "nmc", doc as never, win as never),
    ).toMatchObject({ page: "timeline", scrolled: true });
  });
});
