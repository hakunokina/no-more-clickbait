// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { format, t, tm } from "./i18n.js";
import { EN, TR, type MessageKey } from "./i18n/messages.js";
import {
  paginationHints,
  pickRequestCandidate,
  requestPatternFor,
} from "./picker/page-hints.js";
import { newsPageHtml } from "./sites/test-fixtures.js";

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\$([1-9])/g)].map((m) => m[1] ?? "").sort();

describe("UI messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has every English key in Turkish, with the same arguments", () => {
    const keys = Object.keys(EN) as MessageKey[];
    expect(Object.keys(TR).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect([key, placeholders(TR[key])]).toEqual([key, placeholders(EN[key])]);
      // chrome.i18n keys: ASCII letters, digits, "_" and "@" only.
      expect(key).toMatch(/^[A-Za-z0-9_@]+$/);
      // A lone "$" would be read as a placeholder by chrome.i18n.
      expect(EN[key].replace(/\$[1-9]/g, "")).not.toContain("$");
      expect(TR[key].replace(/\$[1-9]/g, "")).not.toContain("$");
    }
  });

  it("falls back to English outside the extension and fills arguments", () => {
    expect(t("pickFieldCoverage", "Title", 2, 3)).toBe("Title: found in 2/3 cards.");
    expect(tm({ key: "pickFieldCoverage", args: [{ key: "roleTitle" }, 1, 1] })).toBe(
      "Title: found in 1/1 cards.",
    );
    expect(format("$2 and $1, $3", ["a", "b"])).toBe("b and a, ");
  });

  it("uses chrome.i18n when it answers", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string, subs: string[]) =>
          key === "save" ? "Kaydet" : `${key}:${subs.join(",")}`,
      },
    });
    expect(t("save")).toBe("Kaydet");
    expect(t("cursorSimilar", 4)).toBe("cursorSimilar:4");
  });
});

describe("'more' hints on the page", () => {
  it("finds the load-more button outside the cards and a rel=next link", () => {
    document.documentElement.innerHTML = new DOMParser().parseFromString(
      newsPageHtml(4),
      "text/html",
    ).documentElement.innerHTML;
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a rel="next" href="/world?page=2">Next</a>',
    );
    const cards = Array.from(document.querySelectorAll("article.card"));
    expect(paginationHints(document, () => true, cards)).toEqual({
      loadMore: { selector: "button.more", label: "Load more stories" },
      nextPage: { selector: 'a[rel~="next"]' },
    });
  });

  it("takes the same-origin HTML response holding most cards as the 'more' request", () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const origin = "https://news.example.invalid";
    const candidate = pickRequestCandidate(
      [
        {
          url: "https://cdn.example.invalid/more",
          contentType: "text/html",
          bodyText: newsPageHtml(9),
        },
        { url: `${origin}/api/track`, contentType: "application/json", bodyText: "{}" },
        {
          url: `${origin}/api/more?page=2`,
          contentType: "text/html; charset=utf-8",
          bodyText: newsPageHtml(5),
        },
      ],
      origin,
      "article.card",
      parse,
    );
    expect(candidate).toEqual({
      pattern: "news.example.invalid/api/more",
      format: "html",
      cards: 5,
    });
    expect(
      pickRequestCandidate(
        [{ url: `${origin}/api/more`, contentType: "application/json", bodyText: "{}" }],
        origin,
        "article.card",
        parse,
      ),
    ).toEqual({ pattern: "news.example.invalid/api/more", format: "json", cards: 0 });
    expect(requestPatternFor("https://news.example.invalid/a b*/c")).toBeUndefined();
  });
});
