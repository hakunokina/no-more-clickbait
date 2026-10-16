import { describe, expect, it, vi } from "vitest";
import {
  answerInstagramModeBStep,
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
    // Any other sign-in redirect under /accounts/ is the login flow too, not "away".
    expect(classifyInstagramPage(facts({ pathname: "/accounts/onetap/" }))).toBe("login");
    expect(classifyInstagramPage(facts({ pathname: "/accounts/login" }))).toBe("login");
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

describe("answerInstagramModeBStep (the content script's listener)", () => {
  const step = { kind: "mode-b-step", source: "instagram" };

  it("ignores a step from another extension, or from no extension at all", () => {
    const { win, doc } = fakePage(9_000);
    for (const sender of [{ id: "someone-else" }, {}]) {
      expect(
        answerInstagramModeBStep(step, sender, "nmc", doc as never, win as never),
      ).toBeUndefined();
    }
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores messages that are not a well-formed step", () => {
    const { win, doc } = fakePage(9_000);
    for (const message of [undefined, { kind: "instagram-capture" }, { ...step, source: 1 }]) {
      expect(
        answerInstagramModeBStep(message, { id: "nmc" }, "nmc", doc as never, win as never),
      ).toBeUndefined();
    }
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls on its own step", () => {
    const { win, doc } = fakePage(9_000);
    expect(
      answerInstagramModeBStep(step, { id: "nmc" }, "nmc", doc as never, win as never),
    ).toMatchObject({ page: "timeline", scrolled: true });
  });
});
