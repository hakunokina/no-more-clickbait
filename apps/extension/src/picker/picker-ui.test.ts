// @vitest-environment happy-dom
import { SiteRuleSchema } from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteWorkerMessage } from "../sites/site-messages.js";
import { newsPageHtml, siteRule } from "../sites/test-fixtures.js";
import { PickerUI, type PickerInit } from "./picker-ui.js";

const target = {
  url: "https://news.example.invalid/world",
  pattern: "news.example.invalid/world/*",
};

let ui: PickerUI;
let sent: SiteWorkerMessage[];

async function mount(init: PickerInit = { target }): Promise<PickerUI> {
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    newsPageHtml(6),
    "text/html",
  ).documentElement.innerHTML;
  sent = [];
  ui = new PickerUI(
    {
      doc: document,
      win: window,
      send: vi.fn((message: SiteWorkerMessage) => {
        sent.push(message);
        if (message.kind === "site-probe") return Promise.resolve({ ok: true, count: 6 });
        if (message.kind === "site-picker-save") {
          return Promise.resolve({
            ok: true,
            id: "news.example.invalid/world",
            staticWorked: true,
          });
        }
        return Promise.resolve({ ok: true });
      }),
      now: () => "2026-10-15T12:00:00.000Z",
      loadTheme: () => Promise.resolve("system"),
      saveTheme: vi.fn(),
      shadowMode: "open",
    },
    init,
  );
  await ui.mount();
  return ui;
}

const $ = (selector: string, index = 0): HTMLElement => {
  const el = document.querySelectorAll<HTMLElement>(selector)[index];
  if (!el) throw new Error(`no ${selector}`);
  return el;
};
const inShadow = (selector: string): HTMLElement | null =>
  ui.shadow.querySelector<HTMLElement>(selector);
const click = (el: Element | null): void => {
  if (!el) throw new Error("nothing to click");
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }),
  );
};
const key = (keyName: string, at: Element = document.body): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    key: keyName,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  at.dispatchEvent(event);
  return event;
};

describe("in-page picker", () => {
  beforeEach(async () => {
    await mount();
  });
  afterEach(() => ui.destroy());

  it("starts with 'Pick myself'; Claude's suggestion is disabled until the desktop path exists", () => {
    const claude = inShadow("[data-p='claude']");
    expect(claude?.getAttribute("aria-disabled")).toBe("true");
    expect(claude?.textContent).toContain("Needs the desktop app — coming soon");
    expect(ui.shadow.activeElement?.getAttribute("data-p")).toBe("manual");
    expect(document.documentElement.lastElementChild).toBe(ui.host);
  });

  it("clicking the page picks instead of following links; a role assigns the field", () => {
    click(inShadow("[data-p='manual']"));
    expect(ui.mode).toBe("pick");
    expect(ui.shadow.activeElement?.id).toBe("cursorbox");

    const link = $("a.link", 1);
    const event = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ui.popTarget).toBe(link);
    expect(inShadow(".pop")?.hidden).toBe(false);

    // In the role window, "2" is Title (keyboard shortcut 1–8).
    key("2", ui.shadow.activeElement ?? document.body);
    expect(ui.model.card).toBe("article.card");
    expect(ui.model.fields.title?.selector).toBe("a.link");
    expect(inShadow(".pop")?.hidden).toBe(true);
    expect(inShadow("[data-p='preview']")?.hasAttribute("disabled")).toBe(false);
    expect(inShadow(".roles")?.textContent).toContain("6/6");
  });

  it("moves with the keyboard: ↓ to the first card, Enter for roles, 1 for Content card", () => {
    click(inShadow("[data-p='manual']"));
    const box = inShadow("#cursorbox");
    if (!box) throw new Error("no cursor box");
    key("ArrowDown", box);
    expect(ui.cursor?.tagName).toBe("ARTICLE");
    key("ArrowDown", box);
    expect(ui.cursor?.tagName).toBe("A");
    key("ArrowUp", box);
    expect(ui.cursor?.tagName).toBe("ARTICLE");
    key("ArrowRight", box);
    expect(ui.cursor).toBe($("article.card", 1));
    key("Enter", box);
    expect(ui.popTarget).toBe($("article.card", 1));
    key("1", ui.shadow.activeElement ?? box);
    expect(ui.model.card).toBe("article.card");
    expect(ui.shadow.activeElement?.id).toBe("cursorbox");
  });

  it("Esc closes the role window, then asks before leaving an unsaved selection", () => {
    click(inShadow("[data-p='manual']"));
    click($("h2.title"));
    key("2", ui.shadow.activeElement ?? document.body);
    click($("p.summary"));
    expect(ui.popTarget).not.toBeNull();
    key("Escape");
    expect(ui.popTarget).toBeNull();
    key("Escape");
    expect(ui.mode).toBe("confirm-exit");
    expect(ui.shadow.activeElement?.getAttribute("data-p")).toBe("resume");
    key("Escape");
    expect(ui.mode).toBe("pick");
    key("Escape");
    click(inShadow("[data-p='close']"));
    expect(document.documentElement.contains(ui.host)).toBe(false);
  });

  it("'Not this card' from the role window drops the sponsored cards", () => {
    click(inShadow("[data-p='manual']"));
    click($("h2.title"));
    key("2", ui.shadow.activeElement ?? document.body);
    click($("article.card", 2).querySelector(".sponsor"));
    click(inShadow("[data-pop='notthis']"));
    expect(ui.model.keptCards()).toHaveLength(4);
    expect(inShadow(".roles")?.textContent).toContain("cards with “Sponsored”");
    expect(inShadow(".note")?.textContent).toContain("2 cards excluded");
    click(inShadow("[data-p='undo']"));
    expect(ui.model.keptCards()).toHaveLength(6);
  });

  it("previews the first 5 items with core's engine and saves a valid rule", async () => {
    click(inShadow("[data-p='manual']"));
    click($("h2.title"));
    key("2", ui.shadow.activeElement ?? document.body);
    click($("p.summary"));
    key("3", ui.shadow.activeElement ?? document.body);
    click(inShadow("[data-p='preview']"));
    expect(ui.mode).toBe("preview");
    expect(inShadow(".drawer")?.hidden).toBe(false);
    expect(ui.shadow.querySelectorAll(".drawer .post")).toHaveLength(5);
    expect(inShadow(".d-sum")?.textContent).toContain("6 items");
    expect(inShadow(".drawer .post__title")?.textContent).toBe("Synthetic headline 0");
    // "Load more stories" was detected as the pagination button.
    expect((inShadow("#f-page") as HTMLSelectElement).value).toBe("load-more");
    await vi.waitFor(() =>
      expect(inShadow("#f-method-note")?.textContent).toContain("in the page's HTML"),
    );

    click(inShadow("[data-p='save']"));
    await vi.waitFor(() => expect(ui.mode).toBe("saved"));
    const save = sent.find((m) => m.kind === "site-picker-save");
    if (save?.kind !== "site-picker-save") throw new Error("not saved");
    expect(save.foundCount).toBe(6);
    const rule = SiteRuleSchema.parse(save.rule);
    expect(rule).toMatchObject({
      id: "news.example.invalid/world",
      match: ["news.example.invalid/world/*"],
      item: { selector: "article.card" },
      collect: { method: "auto" },
      pagination: { type: "load-more", selector: "button.more", maxPages: 3 },
    });
    expect(ui.shadow.activeElement?.getAttribute("data-p")).toBe("to-options");
    click(inShadow("[data-p='to-options']"));
    expect(sent.at(-1)?.kind).toBe("site-open-options");
  });

  it("re-picking loads a rule that still matches, with how much of it does", async () => {
    ui.destroy();
    await mount({
      target: { ...target, repickOf: "news.example.invalid/world" },
      rule: siteRule(),
    });
    expect(ui.mode).toBe("pick");
    expect(inShadow(".p-brand")?.textContent).toBe("Re-pick the rule");
    expect(inShadow(".note--ok")?.textContent).toContain("4 of its 4 selectors still match");
  });

  it("re-picking a rule that no longer matches says why on the start screen", async () => {
    ui.destroy();
    await mount({
      target: { ...target, repickOf: "x" },
      rule: siteRule({ item: { selector: "div.gone" } }),
    });
    expect(ui.mode).toBe("start");
    expect(inShadow(".note--warn")?.textContent).toContain("div.gone");
  });

  it("minimizes to a pill and moves to the other side", () => {
    click(inShadow("#p-min"));
    expect(inShadow(".panel")?.hidden).toBe(true);
    expect(inShadow(".pill")?.hidden).toBe(false);
    click(inShadow(".pill"));
    expect(inShadow(".panel")?.hidden).toBe(false);
    click(inShadow("#p-side"));
    expect(inShadow(".panel")?.dataset["side"]).toBe("left");
  });
});
