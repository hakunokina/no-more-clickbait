import { describe, expect, it, vi } from "vitest";
import {
  classifyInstagramPage,
  instagramScrollStep,
  type InstagramPageFacts,
} from "./instagram-mode-b-page.js";

const facts = (overrides: Partial<InstagramPageFacts> = {}): InstagramPageFacts => ({
  pathname: "/",
  hasLoginForm: false,
  postCount: 8,
  ...overrides,
});

describe("classifyInstagramPage", () => {
  it("sees a loaded or still-loading home feed", () => {
    expect(classifyInstagramPage(facts())).toBe("timeline");
    expect(classifyInstagramPage(facts({ postCount: 0 }))).toBe("loading");
  });

  it("sees the logged-out home page and the login flow", () => {
    expect(classifyInstagramPage(facts({ hasLoginForm: true, postCount: 0 }))).toBe("login");
    expect(classifyInstagramPage(facts({ pathname: "/accounts/login/" }))).toBe("login");
    expect(classifyInstagramPage(facts({ pathname: "/accounts/emailsignup/" }))).toBe("login");
  });

  it("sees a tab that left the home feed", () => {
    expect(classifyInstagramPage(facts({ pathname: "/explore/" }))).toBe("away");
    expect(classifyInstagramPage(facts({ pathname: "/someone/" }))).toBe("away");
  });
});

function fakePage(scrollHeight: number) {
  const win = {
    scrollY: 0,
    scrollTo: vi.fn((_x: number, y: number) => {
      win.scrollY = Math.min(y, scrollHeight - 800);
    }),
    dispatchEvent: vi.fn(() => true),
  };
  const lastPost = { scrollIntoView: vi.fn() };
  const doc = {
    hidden: true,
    location: { pathname: "/" },
    scrollingElement: { scrollHeight },
    documentElement: { scrollHeight },
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === "main article" ? [{}, lastPost] : []),
  };
  return { win, doc, lastPost };
}

describe("instagramScrollStep", () => {
  it("jumps to the bottom of the feed and fires a scroll event", () => {
    const { win, doc, lastPost } = fakePage(9_000);
    const report = instagramScrollStep(doc as never, win as never, {
      kind: "mode-b-step",
      source: "instagram",
    });
    expect(win.scrollTo).toHaveBeenCalledWith(0, 9_000);
    expect(lastPost.scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(win.dispatchEvent).toHaveBeenCalled();
    expect(report).toEqual({
      kind: "mode-b-page",
      page: "timeline",
      hidden: true,
      scrolled: true,
    });
  });

  it("answers away to a step meant for X, without scrolling", () => {
    const { win, doc } = fakePage(9_000);
    const report = instagramScrollStep(doc as never, win as never, { kind: "mode-b-step" });
    expect(report.page).toBe("away");
    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});
