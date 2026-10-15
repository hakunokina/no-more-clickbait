// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  distinguishing,
  fieldSelectorFor,
  fieldSelectorForResult,
  inferItem,
  isStableClass,
  selectorFor,
} from "./selectors.js";
import { SelectorSchema } from "./site-rule.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

function page(name: string): Document {
  const html = readFileSync(join(fixtures, "sites", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

function one(root: Document | Element, selector: string): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

describe("isStableClass", () => {
  it("keeps meaningful classes and drops generated or state ones", () => {
    for (const name of ["np-card", "post-card", "col-6", "card__title", "card--featured"]) {
      expect(isStableClass(name), name).toBe(true);
    }
    for (const name of [
      "css-1x2y3a",
      "sc-AxjAm",
      "_a1B2c",
      "Card_title__3xYz9",
      "x9f8e7d6",
      "is-active",
      "selected",
      "md:flex",
      "w-1/2",
    ]) {
      expect(isStableClass(name), name).toBe(false);
    }
  });
});

describe("news page", () => {
  const doc = page("news.html");
  const card = one(doc, 'article[data-id="104"]');
  const title = one(card, "h2");

  it("names a clicked element by tag and its most stable feature", () => {
    expect(selectorFor(title)).toBe("h2.np-title");
    expect(selectorFor(one(doc, 'article[data-id="103"]'))).toBe("article.np-card");
    expect(selectorFor(one(card, "time"))).toBe("time");
  });

  it("finds the card from a click on its title and covers every sibling card", () => {
    const result = inferItem(title, doc);
    expect(result).toEqual({ ok: true, card, selector: "article.np-card", count: 8 });
    // The hero article is another shape: the bare tag is not chosen.
    expect(doc.querySelectorAll("article")).toHaveLength(9);
  });

  it("writes field selectors relative to the card", () => {
    expect(fieldSelectorFor(title, card)).toBe("h2.np-title");
    expect(fieldSelectorFor(one(card, "time"), card)).toBe("time");
    expect(fieldSelectorFor(card, card)).toBe(":scope");
    expect(fieldSelectorFor(one(doc, "button.np-more"), card)).toBeNull();
  });

  it('turns "not this one" into a feature the other cards lack', () => {
    const cards = doc.querySelectorAll("article.np-card");
    const sponsored = one(doc, 'article[data-id="103"]');
    expect(distinguishing(sponsored, cards)).toEqual({
      ok: true,
      exclude: ".np-card--sponsored",
      removed: 1,
    });
    // Without the modifier class, the label inside still tells it apart.
    sponsored.classList.remove("np-card--sponsored");
    expect(distinguishing(sponsored, cards)).toEqual({
      ok: true,
      exclude: ":has(.np-sponsor)",
      removed: 1,
    });
    sponsored.classList.add("np-card--sponsored");
  });

  it("says so when an ordinary card cannot be told apart", () => {
    const cards = doc.querySelectorAll("article.np-card");
    expect(distinguishing(one(doc, 'article[data-id="102"]'), cards)).toEqual({
      ok: false,
      reason: "no-distinguishing-feature",
    });
  });

  it("does not invent a card where nothing repeats", () => {
    expect(inferItem(one(doc, "h1.np-hero-title a"), doc)).toEqual({
      ok: false,
      reason: "not-repeated",
    });
  });
});

describe("generated class names (blog)", () => {
  const doc = page("blog.html");

  it("prefers the test id and never writes a hashed class", () => {
    const link = one(doc, 'a[href="2026/10/ikinci-yazi"]');
    const result = inferItem(link, doc);
    expect(result).toMatchObject({
      ok: true,
      selector: 'div[data-testid="post-card"]',
      count: 3,
    });
    expect(selectorFor(one(doc, "h3"))).toBe("h3");
    if (!result.ok) throw new Error("no card");
    expect(fieldSelectorFor(link, result.card)).toBe("a");
  });
});

describe("featureless cards (forum)", () => {
  const doc = page("forum.html");

  it("puts the container into the selector so look-alikes elsewhere stay out", () => {
    const link = one(doc, 'a[href="/t/2"]');
    const result = inferItem(link, doc);
    expect(result).toMatchObject({ ok: true, selector: "ul.threads > li", count: 5 });
    expect(doc.querySelectorAll("li")).toHaveLength(7);
  });

  it("excludes a promoted row by its data attribute", () => {
    const rows = doc.querySelectorAll("ul.threads > li");
    expect(distinguishing(one(doc, "li[data-promoted]"), rows)).toEqual({
      ok: true,
      exclude: "[data-promoted]",
      removed: 1,
    });
  });

  it("falls back to :nth-of-type only when nothing else is unique", () => {
    document.body.innerHTML = "<ul><li><span>a</span><span>b</span></li></ul>";
    const card = one(document, "li");
    const second = card.children[1]!;
    const selector = fieldSelectorFor(second, card);
    expect(selector).toBe(":scope > span:nth-of-type(2)");
    expect(card.querySelector(selector!)).toBe(second);
    document.body.innerHTML = "";
  });
});

describe("generated selectors always fit the rule schema", () => {
  it("every selector the fixtures produce passes SelectorSchema", () => {
    const made: string[] = [];
    for (const name of ["news.html", "blog.html", "forum.html"]) {
      const doc = page(name);
      for (const el of Array.from(doc.querySelectorAll("*")).slice(0, 400)) {
        made.push(selectorFor(el));
        const found = inferItem(el, doc);
        if (found.ok) {
          made.push(found.selector);
          const cards = doc.querySelectorAll(found.selector);
          const unlike = distinguishing(found.card, cards);
          if (unlike.ok) made.push(unlike.exclude);
          for (const field of Array.from(found.card.querySelectorAll("*")).slice(0, 20)) {
            const selector = fieldSelectorFor(field, found.card);
            if (selector) made.push(selector);
          }
        }
      }
    }
    expect(made.length).toBeGreaterThan(100);
    for (const selector of made) {
      expect(SelectorSchema.safeParse(selector).success, selector).toBe(true);
    }
  });

  it("says selector-too-long when no fitting selector reads the element", () => {
    // Two identical deep chains: every short suffix first-matches the
    // first chain's copy, so only the full positional path reads `el` —
    // and it exceeds MAX_SELECTOR_CHARS.
    const chain = `${"<div>".repeat(12)}<span>derin</span>${"</div>".repeat(12)}`;
    document.body.innerHTML = `<section>${chain}${chain}</section>`;
    const card = one(document, "section");
    const chains = card.querySelectorAll(":scope > div");
    const el = chains[1]!.querySelector("span")!;
    const result = fieldSelectorForResult(el, card);
    expect(result).toEqual({ ok: false, reason: "selector-too-long" });
    // The legacy signature stays backward compatible: too long reads as null.
    expect(fieldSelectorFor(el, card)).toBeNull();
    document.body.innerHTML = "";
  });

  it("falls back to a shorter suffix when only it fits the schema", () => {
    // The full `:scope >` path is ~300 chars; a shorter descendant
    // suffix still first-matches `el` ("önce" is a direct child of the
    // card, never of a div, so no earlier element matches).
    document.body.innerHTML =
      `<section><span>önce</span>${"<div>".repeat(12)}<span>hedef</span>${"</div>".repeat(12)}</section>`;
    const card = one(document, "section");
    const el = one(card, "div span");
    const result = fieldSelectorForResult(el, card);
    if (!result.ok) throw new Error(`expected a selector: ${result.reason}`);
    expect(result.selector.startsWith(":scope ")).toBe(true);
    expect(result.selector.startsWith(":scope >")).toBe(false);
    expect(SelectorSchema.safeParse(result.selector).success).toBe(true);
    expect(card.querySelector(result.selector)).toBe(el);
    document.body.innerHTML = "";
  });
});
