// @vitest-environment happy-dom
import { SiteRuleSchema } from "@nmc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { tm } from "../i18n.js";
import { newsPageHtml } from "../sites/test-fixtures.js";
import { PickerModel } from "./picker-model.js";

function load(count = 6): PickerModel {
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    newsPageHtml(count),
    "text/html",
  ).documentElement.innerHTML;
  return new PickerModel(
    document,
    (el) => el !== document.body && el !== document.documentElement,
  );
}

const $ = (selector: string, index = 0): Element => {
  const el = document.querySelectorAll(selector)[index];
  if (!el) throw new Error(`no ${selector}`);
  return el;
};

describe("PickerModel", () => {
  let m: PickerModel;
  beforeEach(() => {
    m = load();
  });

  it("finds the card from a clicked headline and takes its link too", () => {
    const result = m.assign("title", $("h2.title", 1));
    expect(result.ok).toBe(true);
    expect(m.card).toBe("article.card");
    expect(m.keptCards()).toHaveLength(6);
    expect(m.fields.title).toEqual({ selector: "h2.title" });
    expect(m.fields.link).toEqual({ selector: "a.link", attr: "href" });
    expect(result.ok && result.msg.map(tm)).toEqual([
      "The card was found too: 6 × article.card.",
      "The link in the title was taken as Link too.",
      "Title: found in 6/6 cards.",
    ]);
  });

  it("refuses a field outside any repeating card, with the reason", () => {
    const result = m.assign("text", $("h1.h"));
    expect(result.ok).toBe(false);
    expect(result.msg.map(tm)[0]).toMatch(/not inside a repeating card/);
    expect(m.card).toBeNull();
  });

  it("reads time from datetime and an image from the img inside", () => {
    m.assign("card", $("article.card"));
    m.assign("time", $("time"));
    m.assign("image", $("a.media"));
    expect(m.fields.time).toEqual({ selector: "time", attr: "datetime" });
    expect(m.fields.image).toEqual({ selector: "img.thumb" });
    expect(m.coverage("image")).toEqual({ n: 6, of: 6 });
  });

  it("'not this card' writes a distinguishing feature and can be undone", () => {
    m.assign("title", $("h2.title"));
    const sponsored = $("article.card", 2);
    const result = m.excludeCard(sponsored);
    expect(result.ok && result.msg.map(tm)[0]).toBe(
      "2 cards excluded — they all have “Sponsored”.",
    );
    expect(m.excludes).toEqual([{ selector: ":has(.sponsor)", label: "Sponsored" }]);
    expect(m.keptCards()).toHaveLength(4);
    if (result.ok) result.undo?.();
    expect(m.keptCards()).toHaveLength(6);
  });

  it("says honestly when an exclusion cannot be written", () => {
    document.body.innerHTML =
      "<ul>" +
      Array.from({ length: 4 }, (_, i) => `<li><b>Item ${i}</b></li>`).join("") +
      "</ul>";
    m = new PickerModel(document, (el) => el !== document.body);
    m.assign("title", $("b"));
    const result = m.excludeCard($("li", 1));
    expect(result.ok && result.warn).toBe(true);
    expect(m.notThis.size).toBe(1);
    expect(m.excludes).toEqual([]);
  });

  it("'cut' inside a card strips that part in every card; outside it is feedback only", () => {
    m.assign("text", $("p.summary"));
    const inner = m.assign("cut", $("span.promo"));
    expect(m.strip).toEqual(["span.promo"]);
    expect(inner.ok && inner.msg.map(tm)[0]).toBe(
      "“span.promo” is cut from the text of every card.",
    );
    m.assign("cut", $("aside.aside"));
    expect(m.outside).toHaveLength(1);
    expect(m.assignedRole($("aside.aside"))).toBe("cut");
    m.clearCutOn($("aside.aside"));
    expect(m.outside).toHaveLength(0);
  });

  it("builds a rule the core schema accepts, and reloads it", () => {
    m.assign("title", $("h2.title"));
    m.assign("text", $("p.summary"));
    m.excludeCard($("article.card", 2));
    m.assign("cut", $("span.promo"));
    const rule = SiteRuleSchema.parse(
      m.toRule({
        url: "https://news.example.invalid/world",
        pattern: "news.example.invalid/world/*",
        name: "News",
        collect: { method: "auto" },
        pagination: { type: "load-more", selector: "button.more", maxPages: 3 },
        minItems: 3,
        createdAt: "2026-10-15T10:00:00.000Z",
        now: "2026-10-15T10:00:00.000Z",
      }),
    );
    expect(rule).toMatchObject({
      id: "news.example.invalid/world",
      item: { selector: "article.card", exclude: [":has(.sponsor)"] },
      exclude: { within: ["span.promo"] },
    });
    const again = new PickerModel(document, (el) => el !== document.body);
    expect(again.load(rule)).toEqual({ matching: 6, total: 6, cards: 4 });
    expect(again.excludes[0]?.label).toBe("Sponsored");
  });

  it("counts look-alikes inside the kept cards", () => {
    m.assign("card", $("article.card"));
    expect(m.similarCount($("span.author"))).toBe(6);
    expect(m.similarCount($("article.card"))).toBe(6);
    expect(m.ready()).toBe(false);
    m.assign("text", $("p.summary"));
    expect(m.ready()).toBe(true);
  });
});
