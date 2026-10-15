// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GenericItemSchema } from "../schemas.js";
import type { DomQueryRoot } from "./dom.js";
import { extractItems, matchCards, withoutTracking } from "./extract.js";
import { assessRuleHealth } from "./health.js";
import { SiteRuleSchema, type SiteRule, type SiteRuleInput } from "./site-rule.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** A fixture page as a static fetch sees it: parsed, not rendered. */
function page(name: string): Document {
  const html = readFileSync(join(fixtures, "sites", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

const newsInput = JSON.parse(
  readFileSync(join(fixtures, "sites", "news.rule.json"), "utf8"),
) as SiteRuleInput;
const newsRule = SiteRuleSchema.parse(newsInput);

function rule(overrides: Partial<SiteRuleInput>): SiteRule {
  return SiteRuleSchema.parse({ ...newsInput, ...overrides });
}

const root = (doc: Document): DomQueryRoot => doc;

describe("extractItems — news page", () => {
  const doc = page("news.html");
  const before = doc.documentElement.outerHTML;
  const { items, stats } = extractItems(root(doc), newsRule);

  it("reads the cards into valid generic items", () => {
    for (const item of items) expect(GenericItemSchema.parse(item)).toEqual(item);
    expect(items.map((item) => item.title)).toEqual([
      "Köprü ihalesi yeniden açıldı",
      "Park alanı genişliyor",
      "Otobüs hatları değişti",
      "Kütüphane gece de açık",
      "Canlı: meclis oturumu",
    ]);
    expect(items[0]).toEqual({
      platform: "generic",
      id: expect.stringMatching(/^u[0-9a-f]{16}$/),
      sourceLabel: "custom:Kuzeykent Postası — Gündem",
      title: "Köprü ihalesi yeniden açıldı",
      // The inline promo is left out; whitespace is collapsed.
      text: "Belediye meclisi ihaleyi iptal etti.",
      url: "https://haber.example.invalid/gundem/kopru-ihalesi#yorumlar",
      domain: "haber.example.invalid",
      kind: "link",
      lang: "tr",
      author: "Ayşe Yılmaz",
      publishedAt: "2026-10-15T05:30:00.000Z",
      // alt="" is decorative: no alt text.
      image: { url: "https://haber.example.invalid/img/kopru.jpg" },
      promoted: false,
    });
  });

  it("resolves images from srcset (widest) and data-src, inline text as words", () => {
    expect(items[1]?.text).toBe("Yeni yeşil alan iki mahalleyi birleştiriyor.");
    expect(items[1]?.image?.url).toBe("https://haber.example.invalid/img/park-960.jpg");
    expect(items[2]?.image?.url).toBe("https://haber.example.invalid/img/otobus.jpg");
    expect(items[2]?.author).toBeUndefined();
  });

  it("never takes a javascript: link; such a card points at the page, id from its text", () => {
    const live = items[4];
    expect(live?.url).toBe("https://haber.example.invalid/gundem");
    expect(live?.id).toMatch(/^t[0-9a-f]{16}$/);
    expect(live?.publishedAt).toBeUndefined();
    expect(live?.kind).toBe("text");
  });

  it("counts what it dropped and what each field covered", () => {
    expect(stats).toEqual({
      matched: 8,
      excluded: 1, // the sponsored card
      duplicates: 1, // same story, without the utm parameter
      empty: 1, // a card with only an author
      items: 5,
      coverage: { title: 5, text: 5, link: 4, author: 4, time: 4, image: 3 },
      invalidSelectors: [],
    });
  });

  it("leaves the page untouched", () => {
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it("is healthy", () => {
    expect(assessRuleHealth(stats, newsRule)).toEqual({
      status: "ok",
      reason: "5 items.",
      lowFields: [],
    });
  });

  it("runs on an element root as well as a document", () => {
    const list = doc.querySelector("section.np-list")!;
    expect(extractItems(list, newsRule).items).toEqual(items);
  });

  it("picks the cards the picker highlights", () => {
    const { cards, matched, excluded } = matchCards(doc, newsRule.item!);
    expect([matched, excluded, cards.length]).toEqual([8, 1, 7]);
    expect(cards.some((card) => card.getAttribute("data-id") === "103")).toBe(false);
  });

  it("validates item.exclude even when the card selector matches nothing", () => {
    const gone = rule({ item: { selector: "article.np-gone", exclude: ["span["] } });
    // A fresh document per evaluation: happy-dom reports an invalid
    // selector only on the first use per element, so reusing one document
    // would make the second call pass silently.
    const { cards, matched, invalidSelectors } = matchCards(page("news.html"), gone.item!);
    expect([matched, cards.length]).toEqual([0, 0]);
    expect(invalidSelectors).toEqual(["span["]);
    expect(extractItems(page("news.html"), gone).stats.invalidSelectors).toEqual(["span["]);
  });

  it("reports no invalid selector when a 0-match exclusion is valid", () => {
    const gone = rule({ item: { selector: "article.np-gone", exclude: [".np-card"] } });
    expect(matchCards(doc, gone.item!).invalidSelectors).toEqual([]);
  });

  it("leaves inline-hidden text out of the fields", () => {
    document.body.innerHTML =
      `<article class="c"><h2>Başlık<span style="display:none"> gizli promo</span></h2>` +
      `<p>Metin<span style="VISIBILITY : hidden !important"> gizli</span>` +
      `<span style="display:block"> görünen</span></p></article>`;
    const hidden = rule({
      id: "o.example.invalid/x",
      name: "O",
      url: "https://o.example.invalid/x",
      match: ["o.example.invalid/x"],
      item: { selector: "article.c" },
      fields: { title: { selector: "h2" }, text: { selector: "p" } },
      exclude: { within: [] },
    });
    const { items } = extractItems(document, hidden);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Başlık");
    expect(items[0]?.text).toBe("Metin görünen");
    document.body.innerHTML = "";
  });
});

describe("extractItems — URLs and fallbacks", () => {
  it("resolves links against <base href> and reads block text as separate words", () => {
    const blog = rule({
      id: "blog.example.invalid/yazilar",
      name: "Blog",
      url: "https://blog.example.invalid/yazilar/",
      match: ["blog.example.invalid/yazilar/*"],
      item: { selector: 'div[data-testid="post-card"]' },
      fields: { title: { selector: "h3 a" }, text: { selector: "h3 + div" } },
      exclude: { within: [] },
    });
    const { items, stats } = extractItems(page("blog.html"), blog);
    expect(items.map((item) => [item.url, item.text])).toEqual([
      [
        "https://blog.example.invalid/yazilar/2026/10/ilk-yazi",
        "Birinci paragraf. İkinci paragraf.",
      ],
      ["https://blog.example.invalid/yazilar/2026/10/ikinci-yazi", "Kısa özet."],
      // aria-hidden decoration is not text
      ["https://blog.example.invalid/hakkinda", "Gizli değil ama yıldızsız."],
    ]);
    // No link field: the title's own link is used, but not counted as a link field.
    expect(stats.coverage.link).toBe(0);
  });

  it("uses the card itself as a field with :scope (its first link inside)", () => {
    const forum = rule({
      id: "forum.example.invalid/konular",
      name: "Forum",
      url: "https://forum.example.invalid/konular",
      match: ["forum.example.invalid/konular"],
      item: { selector: "ul.threads > li", exclude: ["[data-promoted]"] },
      fields: {
        title: { selector: ":scope > a" },
        text: { selector: ":scope > span" },
        link: { selector: ":scope" },
      },
      exclude: { within: [] },
    });
    const { items } = extractItems(page("forum.html"), forum, {
      pageUrl: "https://forum.example.invalid/konular?sayfa=2",
    });
    expect(items.map((item) => [item.title, item.text, item.url])).toEqual([
      ["Bisiklet yolu önerisi", "12 yanıt", "https://forum.example.invalid/t/1"],
      ["Kayıp kedi bulundu", "4 yanıt", "https://forum.example.invalid/t/2"],
      ["Pazar yeri saatleri", "7 yanıt", "https://forum.example.invalid/t/3"],
      ["Su kesintisi ne zaman bitecek?", "30 yanıt", "https://forum.example.invalid/t/4"],
    ]);
    expect(items.every((item) => item.sourceLabel === "custom:Forum")).toBe(true);
  });

  it("strips only click-tracking parameters", () => {
    expect(withoutTracking("https://a.example.invalid/p?id=7&utm_source=x&fbclid=1")).toBe(
      "https://a.example.invalid/p?id=7",
    );
    expect(withoutTracking("https://a.example.invalid/p?id=7")).toBe(
      "https://a.example.invalid/p?id=7",
    );
  });

  it("reads the card's language, the page icon and an image's alt text", () => {
    const doc = new DOMParser().parseFromString(
      `<html lang="tr"><head><link rel="shortcut icon" href="/fav.png"></head><body>
        <article><h2><a href="/a">Bir</a></h2><img src="/a.jpg" alt="  Köprü  çizimi "></article>
        <article lang="en"><h2><a href="/b">Two</a></h2><div><img src="/b.jpg"></div></article>
        <article lang="??"><h2>Üç</h2></article>
      </body></html>`,
      "text/html",
    );
    const site = rule({
      item: { selector: "article" },
      fields: { title: { selector: "h2" }, image: { selector: "img" } },
      exclude: { within: [] },
    });
    const { items } = extractItems(doc, site);
    expect(
      items.map((item) => [item.lang, item.kind, item.image?.altText, item.siteIconUrl]),
    ).toEqual([
      ["tr", "link", "Köprü çizimi", "https://haber.example.invalid/fav.png"],
      ["en", "link", undefined, "https://haber.example.invalid/fav.png"],
      // A malformed tag is dropped (not inherited from the page); no link → text.
      [undefined, "text", undefined, "https://haber.example.invalid/fav.png"],
    ]);
    for (const item of items) expect(GenericItemSchema.parse(item)).toEqual(item);
  });

  it("reads a locale-spelled lang and crosses a shadow root to its host's lang", () => {
    const host = document.createElement("div");
    host.setAttribute("lang", "en_US");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<section><article><h2><a href="https://haber.example.invalid/a">Bir</a></h2></article>
      <article lang="pt_BR"><h2><a href="https://haber.example.invalid/b">Dois</a></h2></article></section>`;
    const site = rule({
      item: { selector: "article" },
      fields: { title: { selector: "h2" } },
      exclude: { within: [] },
    });
    const { items } = extractItems(shadow, site);
    expect(items.map((item) => item.lang)).toEqual(["en-US", "pt-BR"]);
    host.remove();
  });

  it("returns nothing for a feed-only rule", () => {
    const feedOnly = rule({
      item: undefined,
      fields: undefined,
      collect: { method: "rss", rssUrl: "https://haber.example.invalid/gundem/rss.xml" },
    });
    expect(extractItems(page("news.html"), feedOnly).items).toEqual([]);
  });
});

describe("assessRuleHealth", () => {
  const doc = page("news.html");
  const health = (input: Partial<SiteRuleInput>) => {
    const r = rule(input);
    return assessRuleHealth(extractItems(doc, r).stats, r);
  };

  it("is broken when the card selector matches nothing or is invalid", () => {
    expect(health({ item: { selector: "article.np-gone" } })).toMatchObject({
      status: "broken",
      reason: "The card selector matched nothing on the page.",
    });
    const invalid = health({ item: { selector: "article[" } });
    expect(invalid).toMatchObject({ status: "broken" });
    expect(invalid.reason).toMatch(/not valid on this page/);
  });

  it("is broken when every card is excluded or textless", () => {
    expect(
      health({ item: { selector: "article.np-card", exclude: [".np-card"] } }),
    ).toMatchObject({
      status: "broken",
      reason: "No items: all 8 cards were excluded.",
    });
    expect(
      health({ fields: { title: { selector: "h6" }, text: { selector: "blockquote" } } }),
    ).toMatchObject({
      status: "broken",
      reason: "No items: 8 cards matched but none had a title or text.",
    });
  });

  it("reports few items before low coverage", () => {
    expect(health({ health: { minItems: 10 } })).toEqual({
      status: "few-items",
      reason: "Only 5 items (expected at least 10).",
      lowFields: [],
    });
    expect(health({ health: { minItems: 3, minCoverage: 0.7 } })).toEqual({
      status: "low-coverage",
      reason: "Fields often missing: image 3/5.",
      lowFields: ["image"],
    });
  });

  it("reports a field selector the page rejects without failing the fetch", () => {
    const r = rule({ fields: { ...newsInput.fields, author: { selector: "span[" } } });
    const { items, stats } = extractItems(doc, r);
    expect(items).toHaveLength(5);
    expect(stats.invalidSelectors).toEqual(["span["]);
    expect(assessRuleHealth(stats, r)).toMatchObject({
      status: "low-coverage",
      lowFields: ["author"],
    });
  });
});
