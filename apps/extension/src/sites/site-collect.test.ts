// @vitest-environment happy-dom
import { extractItems, type SiteRule } from "@nmc/core";
import { describe, expect, it, vi } from "vitest";
import {
  autoChain,
  collectSite,
  mergeItems,
  type CollectContext,
  type CollectDeps,
  type FetchResult,
} from "./site-collect.js";
import { FEED_XML, genericItem, newsPageHtml, siteRule } from "./test-fixtures.js";

const FEED_URL = "https://news.example.invalid/world/feed.xml";
const fresh: CollectContext = { pageNoteAccepted: false, staticKnownGood: false };

/** Deps over a fake web: `pages` by URL (missing → HTTP 404). */
function deps(
  pages: Record<string, string>,
  extra: Partial<CollectDeps> = {},
): CollectDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    fetchText: (url: string): Promise<FetchResult> => {
      fetched.push(url);
      const text = pages[url];
      return Promise.resolve(
        text === undefined
          ? { ok: false, status: 404, message: "Not Found" }
          : { ok: true, text, finalUrl: url },
      );
    },
    extractStatic: (html: string, pageUrl: string, rule: SiteRule) =>
      Promise.resolve(
        extractItems(new DOMParser().parseFromString(html, "text/html"), rule, { pageUrl }),
      ),
    takeRequestBuffer: vi.fn(() => Promise.resolve(null)),
    collectViaPage: vi.fn(() => Promise.resolve({ ok: true as const, items: [] })),
    ...extra,
  };
}

describe("auto method chain", () => {
  it("orders feed → static → captured request and never includes the page", () => {
    expect(autoChain(siteRule())).toEqual(["static"]);
    expect(
      autoChain(
        siteRule({
          collect: {
            method: "auto",
            rssUrl: FEED_URL,
            request: { match: "news.example.invalid/api/more", format: "html" },
          },
        }),
      ),
    ).toEqual(["rss", "static", "request"]);
  });

  it("takes the feed when it has items, without fetching the page", async () => {
    const rule = siteRule({ collect: { method: "auto", rssUrl: FEED_URL } });
    const web = deps({ [FEED_URL]: FEED_XML, [rule.url]: newsPageHtml() });
    const result = await collectSite(rule, web, fresh);
    expect(result).toMatchObject({ method: "rss", verdict: "ok" });
    expect(result.items.map((item) => item.title)).toEqual([
      "Feed one",
      "Feed two",
      "Feed three",
    ]);
    expect(web.fetched).toEqual([FEED_URL]);
  });

  it("falls back to the static page when the feed is unreachable", async () => {
    const rule = siteRule({ collect: { method: "auto", rssUrl: FEED_URL } });
    const result = await collectSite(rule, deps({ [rule.url]: newsPageHtml() }), fresh);
    expect(result).toMatchObject({ method: "static", verdict: "ok", staticWorked: true });
    expect(result.items).toHaveLength(6);
  });

  it("merges the captured 'more' items once, without repeats", async () => {
    const rule = siteRule({
      collect: {
        method: "auto",
        request: { match: "news.example.invalid/api/more", format: "html" },
      },
    });
    const page = await collectSite(rule, deps({ [rule.url]: newsPageHtml(3) }), fresh);
    const repeat = page.items[0];
    const takeRequestBuffer = vi.fn(() =>
      Promise.resolve({
        items: [repeat!, genericItem("more-1")],
        lastAt: "2026-10-15T09:00:00Z",
      }),
    );
    const result = await collectSite(
      rule,
      deps({ [rule.url]: newsPageHtml(3) }, { takeRequestBuffer }),
      fresh,
    );
    expect(takeRequestBuffer).toHaveBeenCalledWith(rule.id);
    expect(result.items.map((item) => item.id)).toEqual([
      ...page.items.map((item) => item.id),
      genericItem("more-1").id,
    ]);
  });

  it("says 'visible tab needed' for a page drawn by script, and never opens one", async () => {
    const rule = siteRule();
    const empty = "<!doctype html><html><body><div id=app></div></body></html>";
    const web = deps({ [rule.url]: empty });
    const result = await collectSite(rule, web, fresh);
    expect(result.verdict).toBe("visible-tab");
    expect(web.collectViaPage).not.toHaveBeenCalled();
  });

  it("calls a page that worked statically before 'broken' when it stops matching", async () => {
    const rule = siteRule();
    const empty = "<!doctype html><html><body><div id=app></div></body></html>";
    const result = await collectSite(rule, deps({ [rule.url]: empty }), {
      ...fresh,
      staticKnownGood: true,
    });
    expect(result.verdict).toBe("broken");
  });

  it("reports an unreachable page as a fetch error, not a broken rule", async () => {
    const result = await collectSite(siteRule(), deps({}), fresh);
    expect(result).toMatchObject({ verdict: "fetch-error", message: "HTTP 404" });
  });

  it("notes JSON 'more' responses as not read yet", async () => {
    const rule = siteRule({
      collect: {
        method: "auto",
        request: { match: "news.example.invalid/api/more", format: "json" },
      },
    });
    const result = await collectSite(rule, deps({}), fresh);
    expect(result.verdict).toBe("json-unsupported");
  });
});

describe("methods chosen by hand", () => {
  it("rss: a feed that is not XML is a broken rule with the reason", async () => {
    const rule = siteRule({ collect: { method: "rss", rssUrl: FEED_URL } });
    const result = await collectSite(rule, deps({ [FEED_URL]: "<html>" }), fresh);
    expect(result.verdict).toBe("broken");
    expect(result.message).toMatch(/XML|feed/);
  });

  it("static: rule health decides (few items)", async () => {
    const rule = siteRule({ collect: { method: "static" }, health: { minItems: 5 } });
    const result = await collectSite(rule, deps({ [rule.url]: newsPageHtml(2) }), fresh);
    expect(result).toMatchObject({ method: "static", verdict: "few-items" });
  });

  it("page: waits for the one-time note, then opens the page", async () => {
    const rule = siteRule({ collect: { method: "page" } });
    const collectViaPage = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        items: [genericItem("a"), genericItem("b"), genericItem("c")],
      }),
    );
    const web = deps({}, { collectViaPage });
    expect((await collectSite(rule, web, fresh)).verdict).toBe("page-note");
    expect(collectViaPage).not.toHaveBeenCalled();
    const result = await collectSite(rule, web, { ...fresh, pageNoteAccepted: true });
    expect(result).toMatchObject({ method: "page", verdict: "ok" });
  });

  it("page: nothing rendered in the hidden window asks for a visible tab", async () => {
    const rule = siteRule({ collect: { method: "page" } });
    const web = deps(
      {},
      {
        collectViaPage: () =>
          Promise.resolve({
            ok: false as const,
            kind: "visible-tab" as const,
            message: "hidden",
          }),
      },
    );
    const result = await collectSite(rule, web, { ...fresh, pageNoteAccepted: true });
    expect(result.verdict).toBe("visible-tab");
  });

  it("request: an empty buffer means the site was not browsed yet", async () => {
    const rule = siteRule({
      collect: {
        method: "request",
        request: { match: "news.example.invalid/api/more", format: "html" },
      },
    });
    expect((await collectSite(rule, deps({}), fresh)).verdict).toBe("visible-tab");
  });
});

describe("mergeItems", () => {
  it("keeps the first copy of each item", () => {
    const a = genericItem("a");
    expect(mergeItems([a], [a, genericItem("b")]).map((item) => item.id)).toEqual([
      a.id,
      genericItem("b").id,
    ]);
  });
});
