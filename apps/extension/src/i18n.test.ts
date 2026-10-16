// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { format, setUiLang, t, tm, uiLang, watchUiLang } from "./i18n.js";
import { EN, TR, type MessageKey } from "./i18n/messages.js";
import {
  paginationHints,
  pickRequestCandidate,
  requestPatternFor,
} from "./picker/page-hints.js";
import { newsPageHtml } from "./sites/test-fixtures.js";

type Changes = Record<string, chrome.storage.StorageChange>;

/**
 * chrome.storage holding these settings and the language the desktop
 * last said it shows (none: it never linked up); pushes land via `push`.
 */
function storage(
  settings?: unknown,
  read: Promise<void> = Promise.resolve(),
  desktopLang?: string,
) {
  const listeners: ((changes: Changes, area: string) => void)[] = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => {
          await read;
          return {
            ...(settings === undefined ? {} : { "nmc-settings": settings }),
            ...(desktopLang === undefined ? {} : { "nmc-desktop-lang": desktopLang }),
          };
        },
      },
      onChanged: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
    },
  });
  return {
    push(next: unknown, area = "local", key = "nmc-settings"): void {
      for (const fn of listeners) fn({ [key]: { newValue: next } }, area);
    },
  };
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\$([1-9])/g)].map((m) => m[1] ?? "").sort();

describe("UI messages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUiLang("en");
  });

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

  it("fills arguments (English before any language is read)", () => {
    expect(t("pickFieldCoverage", "Title", 2, 3)).toBe("Title: found in 2/3 cards.");
    expect(tm({ key: "pickFieldCoverage", args: [{ key: "roleTitle" }, 1, 1] })).toBe(
      "Title: found in 1/1 cards.",
    );
    expect(format("$2 and $1, $3", ["a", "b"])).toBe("b and a, ");
  });

  it.each([
    ["tr", ["en-US"], "en", "tr"],
    ["en", ["tr-TR"], "tr", "en"],
    // "system" is the desktop's language (its OS's), whatever the browser speaks.
    ["system", ["de-DE", "en"], "tr", "tr"],
    ["system", ["tr-TR"], "en", "en"],
    [undefined, ["fr-FR"], "tr", "tr"],
    ["system", ["de-DE"], "de", "en"], // nothing valid from the desktop: the browser's
    // The desktop never linked up: the browser's first language.
    ["system", ["de-DE", "en"], undefined, "en"],
    ["system", ["tr-TR", "en"], undefined, "tr"],
    [undefined, ["tr"], undefined, "tr"],
    [undefined, ["fr-FR"], undefined, "en"],
  ] as const)(
    "speaks the desktop's language: uiLanguage %s, browser %j, desktop shows %s → %s",
    async (uiLanguage, languages, desktopLang, expected) => {
      vi.stubGlobal("navigator", { languages });
      storage(uiLanguage === undefined ? undefined : { uiLanguage }, undefined, desktopLang);
      await watchUiLang(() => undefined);
      expect(uiLang()).toBe(expected);
      expect(t("save")).toBe(expected === "tr" ? "Kaydet" : "Save");
    },
  );

  it('follows the desktop\'s language pushes while set to "system"', async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const store = storage({ uiLanguage: "system" });
    const changes: string[] = [];
    await watchUiLang((lang) => changes.push(lang));
    expect(uiLang()).toBe("en");
    store.push("tr", "local", "nmc-desktop-lang");
    store.push("tr", "local", "nmc-desktop-lang");
    expect(changes).toEqual(["tr"]);
    // An explicit choice wins over the desktop's language, until "system" again.
    store.push({ uiLanguage: "en" });
    store.push("en", "local", "nmc-desktop-lang");
    store.push("tr", "local", "nmc-desktop-lang");
    expect(changes).toEqual(["tr", "en"]);
    store.push({ uiLanguage: "system" });
    expect(changes).toEqual(["tr", "en", "tr"]);
  });

  it("reports a pushed language once, and nothing for other changes", async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const store = storage({ uiLanguage: "en" });
    const changes: string[] = [];
    await watchUiLang((lang) => changes.push(lang));
    store.push({ uiLanguage: "tr", collectTarget: 9 });
    store.push({ uiLanguage: "tr", collectTarget: 8 });
    store.push({ uiLanguage: "en" }, "session");
    store.push({ uiLanguage: "en" }, "local", "nmc.siteRules");
    expect(changes).toEqual(["tr"]);
    // Whether the page switches now is the caller's choice.
    expect(uiLang()).toBe("en");
    store.push({ uiLanguage: "system" });
    expect(changes).toEqual(["tr", "en"]);
  });

  it("takes a push that lands while the stored language is being read", async () => {
    let finishRead: () => void = () => undefined;
    const store = storage(
      { uiLanguage: "en" },
      new Promise<void>((resolve) => (finishRead = resolve)),
    );
    const changes: string[] = [];
    const ready = watchUiLang((lang) => changes.push(lang));
    store.push({ uiLanguage: "tr" });
    finishRead();
    await ready;
    expect(uiLang()).toBe("tr");
    expect(changes).toEqual([]);
  });

  it("takes the desktop's language landing while the stored one is being read", async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    let finishRead: () => void = () => undefined;
    const store = storage(
      { uiLanguage: "system" },
      new Promise<void>((resolve) => (finishRead = resolve)),
      "en",
    );
    const ready = watchUiLang(() => undefined);
    store.push("tr", "local", "nmc-desktop-lang");
    finishRead();
    await ready;
    expect(uiLang()).toBe("tr");
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
