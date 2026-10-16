// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settingCopy } from "@nmc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setUiLang, watchUiLang } from "./i18n.js";
import { localizePage, richText } from "./i18n-dom.js";
import { EN, TR } from "./i18n/messages.js";
import { renderPipelineFields } from "./pipeline-fields.js";

const page = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "public", name), "utf8");

function load(html: string): void {
  // happy-dom would try to load the page's script and stylesheet.
  const bare = html.replace(/<script\b[^>]*><\/script>|<link\b[^>]*>/g, "");
  const parsed = new DOMParser().parseFromString(bare, "text/html");
  document.documentElement.replaceChildren(
    document.importNode(parsed.head, true),
    document.importNode(parsed.body, true),
  );
}

/** The desktop app is set to Turkish. */
function turkish(): void {
  setUiLang("tr");
}

/** Text a user reads that no `data-i18n` element owns (scripts/styles aside). */
function untranslated(): string[] {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  const left: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    const parent = node.parentElement;
    if (!text || !parent || parent.closest("script, style, [data-i18n]")) continue;
    left.push(text);
  }
  return left;
}

describe("static pages (options.html, popup.html)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUiLang("en");
  });

  it.each(["options.html", "popup.html"])("%s: every text has a known key", (name) => {
    load(page(name));
    expect(untranslated()).toEqual([]);
    for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      expect(Object.keys(EN)).toContain(el.dataset["i18n"]);
    }
  });

  it("shows the Options page in Turkish when the desktop is set to Turkish", () => {
    turkish();
    load(page("options.html"));
    localizePage(document);
    expect(document.documentElement.lang).toBe("tr");
    expect(document.title).toBe("No More Clickbait — seçenekler");
    expect(document.querySelector("legend")?.textContent).toBe("Filtre ve doğrulama");
    expect(document.querySelector('button[type="submit"]')?.textContent).toBe("Kaydet");
    expect(document.querySelector("#mode-b-run")?.textContent).toBe("Akışı topla");
    expect(document.querySelector('option[value="fast"]')?.textContent).toBe("Hızlı");
    // The checkbox stays in its label; only the label's text changes.
    const modeB = document.querySelector("#mode-b")?.closest("label");
    expect(modeB?.querySelector("input")).not.toBeNull();
    expect(modeB?.textContent?.trim()).toBe("B modu: gizli bir pencerede kendiliğinden topla");
    const risk = document.querySelector("#dev-capture-risk");
    expect(risk?.querySelector("strong")?.textContent).toBe("Varsayılan olarak kapalı.");
    expect([...(risk?.querySelectorAll("code") ?? [])].map((c) => c.textContent)).toEqual([
      "%LOCALAPPDATA%\\nmc\\captures\\<oturum zamanı>\\",
      "NMC_INBOX_DIR",
      "summary.json",
    ]);
  });

  it("shows the popup in the stored language, and switches it live on a desktop push", async () => {
    // Brave in German: the desktop's choice decides, never the browser's language.
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const listeners: ((changes: object, area: string) => void)[] = [];
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: () => Promise.resolve({ "nmc-settings": { uiLanguage: "tr" } }) },
        onChanged: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
      },
    });
    load(page("popup.html"));
    // What popup.ts does.
    await watchUiLang((lang) => {
      setUiLang(lang);
      localizePage(document);
    });
    localizePage(document);
    expect(document.documentElement.lang).toBe("tr");
    expect(document.querySelector("#open-options")?.textContent).toBe("Seçenekler");
    expect(document.querySelector("p")?.textContent).toBe(TR.popupLead);

    for (const fn of listeners)
      fn({ "nmc-settings": { newValue: { uiLanguage: "system" } } }, "local");
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector("#open-options")?.textContent).toBe("Options");
    expect(document.querySelector("p")?.textContent).toBe(EN.popupLead);
  });

  it("renders the pipeline fields with core's Turkish setting copy", () => {
    turkish();
    document.body.innerHTML = "<div></div>";
    const controls = renderPipelineFields(document.body.firstElementChild as HTMLElement);
    const target = controls.get("collectTarget");
    expect(target?.input.closest("label")?.textContent?.trim()).toBe(
      settingCopy("tr", "collectTarget").label,
    );
    expect(document.querySelector("#setting-collectTarget-hint")?.textContent).toContain(
      "Aralık 1–10000, varsayılan",
    );
  });
});

describe("richText", () => {
  it("makes only <b>, <em> and <code> elements; other text stays text", () => {
    const nodes = richText(document, "<b>A</b> x <code><i>y</i></code> <script>z</script>");
    const box = document.createElement("p");
    box.append(...nodes);
    expect(box.innerHTML).toBe(
      "<strong>A</strong> x <code>&lt;i&gt;y&lt;/i&gt;</code> &lt;script&gt;z&lt;/script&gt;",
    );
  });
});
