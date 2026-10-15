// @vitest-environment happy-dom
import { serializeSiteRule } from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchResult } from "./site-collect.js";
import type { SiteWorkerMessage } from "./site-messages.js";
import type { PermissionsApi } from "./site-permissions.js";
import { loadSiteRules, loadSiteStates, saveSiteRule, updateSiteState } from "./site-store.js";
import { checkSiteUrl, patternChoices, SitesSection } from "./sites-section.js";
import { FEED_XML, MemoryArea, newsPageHtml, siteRule } from "./test-fixtures.js";

const NOW = "2026-10-15T12:00:00.000Z";

interface Harness {
  section: SitesSection;
  local: MemoryArea;
  session: MemoryArea;
  permissions: PermissionsApi & { requested: string[][]; removed: string[][]; accept: boolean };
  sent: SiteWorkerMessage[];
  pages: Record<string, string>;
}

let t: Harness;
/** The worker refuses every message (what Options got before #2023's sender fix). */
let refuse = false;

async function setup(pages: Record<string, string> = {}): Promise<Harness> {
  document.body.innerHTML = '<section id="sites" class="sites"></section>';
  const container = document.querySelector<HTMLElement>("#sites");
  if (!container) throw new Error("no container");
  const permissions = {
    accept: true,
    requested: [] as string[][],
    removed: [] as string[][],
    contains: () => Promise.resolve(false),
    request: vi.fn(({ origins }: { origins: string[] }) => {
      permissions.requested.push(origins);
      return Promise.resolve(permissions.accept);
    }),
    remove: ({ origins }: { origins: string[] }) => {
      permissions.removed.push(origins);
      return Promise.resolve(true);
    },
  };
  const local = new MemoryArea();
  const session = new MemoryArea();
  const sent: SiteWorkerMessage[] = [];
  refuse = false;
  const section = new SitesSection(container, {
    doc: document,
    local,
    session,
    permissions,
    send: (message) => {
      sent.push(message);
      if (refuse) return Promise.resolve({ ok: false, message: "not allowed" });
      if (message.kind === "site-probe") return Promise.resolve({ ok: true, count: 9 });
      return Promise.resolve({ ok: true });
    },
    fetchText: (url): Promise<FetchResult> => {
      const text = pages[url];
      return Promise.resolve(
        text === undefined
          ? { ok: false, status: 404, message: "nope" }
          : { ok: true, text, finalUrl: url },
      );
    },
    now: () => NOW,
    download: vi.fn(),
    copy: vi.fn(() => Promise.resolve()),
    undoMs: 50,
  });
  await section.refresh();
  t = { section, local, session, permissions, sent, pages };
  return t;
}

const q = <E extends Element = HTMLElement>(selector: string): E => {
  const el = document.querySelector<E>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
};
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (form: HTMLFormElement): void => {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

describe("Add site: address check and patterns", () => {
  it("names every address problem", () => {
    const rules = [siteRule()];
    expect(checkSiteUrl("", rules)).toMatchObject({ ok: false, error: "urlErrEmpty" });
    expect(checkSiteUrl("not a url", rules)).toMatchObject({
      ok: false,
      error: "urlErrInvalid",
    });
    expect(checkSiteUrl("ftp://a.example.invalid/x", rules)).toMatchObject({
      ok: false,
      error: "urlErrScheme",
    });
    expect(checkSiteUrl("https://x.com/home", rules)).toMatchObject({
      ok: false,
      error: "urlErrX",
    });
    expect(checkSiteUrl("news.example.invalid/world/", rules)).toEqual({
      ok: false,
      error: "urlErrDup",
      args: ["News — World"],
    });
    expect(checkSiteUrl("http://blog.example.invalid", rules)).toMatchObject({
      ok: true,
      http: true,
    });
  });

  it("recommends 'section/*', or the whole site for a home page", () => {
    const section = patternChoices(new URL("https://news.example.invalid/world?x=1"));
    expect(section.map((c) => [c.value, c.recommended])).toEqual([
      ["news.example.invalid/world", false],
      ["news.example.invalid/world/*", true],
      ["news.example.invalid/*", false],
    ]);
    expect(
      patternChoices(new URL("https://blog.example.invalid/")).map((c) => c.value),
    ).toEqual(["blog.example.invalid/*"]);
  });
});

describe("Options › Sites", () => {
  beforeEach(async () => {
    await setup();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the empty state with Add site and Import", () => {
    expect(q(".empty h3").textContent).toBe("No sites yet");
    click(q(".empty [data-act='add']"));
    expect(q<HTMLFormElement>("#addform").hidden).toBe(false);
    expect(q("#add-btn").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the URL error on blur, then live; marks the field invalid", () => {
    click(q("#add-btn"));
    const input = q<HTMLInputElement>("#url-in");
    type(input, "ftp://x");
    expect(q("#url-err").hidden).toBe(true);
    input.dispatchEvent(new Event("blur"));
    expect(q("#url-err").hidden).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(q("#url-err").textContent).toBe("Only http(s) addresses can be added.");
    type(input, "news.example.invalid/world");
    expect(q("#url-err").hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="pat"]:checked').value).toBe(
      "news.example.invalid/world/*",
    );
    expect(q("#perm-note").textContent).toContain("news.example.invalid");
  });

  it("asks the site's permission inside the click, then opens the picker", async () => {
    click(q("#add-btn"));
    type(q<HTMLInputElement>("#url-in"), "https://news.example.invalid/world");
    submit(q<HTMLFormElement>("#addform"));
    // Requested synchronously, before anything awaited (user gesture).
    expect(t.permissions.requested).toEqual([["https://news.example.invalid/*"]]);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toEqual({
      kind: "site-picker-open",
      target: {
        url: "https://news.example.invalid/world",
        pattern: "news.example.invalid/world/*",
      },
    });
  });

  it("says so when the worker refuses to open the picker", async () => {
    refuse = true;
    click(q("#add-btn"));
    type(q<HTMLInputElement>("#url-in"), "https://news.example.invalid/world");
    submit(q<HTMLFormElement>("#addform"));
    await vi.waitFor(() =>
      expect(q(".toast").textContent).toContain("Could not open the picker: not allowed"),
    );
  });

  it("opens nothing when the browser refuses the permission", async () => {
    t.permissions.accept = false;
    click(q("#add-btn"));
    type(q<HTMLInputElement>("#url-in"), "https://news.example.invalid/world");
    submit(q<HTMLFormElement>("#addform"));
    await vi.waitFor(() => expect(q(".toast").hidden).toBe(false));
    expect(q(".toast").textContent).toContain("did not grant access");
    expect(t.sent).toEqual([]);
  });

  it("offers the site's feed instead of a picker, and adds a feed-only rule", async () => {
    await setup({
      "https://news.example.invalid/world": newsPageHtml(),
      "https://news.example.invalid/world/feed.xml": FEED_XML,
    });
    click(q("#add-btn"));
    type(q<HTMLInputElement>("#url-in"), "https://news.example.invalid/world");
    submit(q<HTMLFormElement>("#addform"));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-act='use-feed']")).not.toBeNull(),
    );
    expect(q("#feed-offer").textContent).toContain("World RSS");
    click(q("[data-act='use-feed']"));
    await vi.waitFor(async () => expect(await loadSiteRules(t.local)).toHaveLength(1));
    const [rule] = await loadSiteRules(t.local);
    expect(rule).toMatchObject({
      name: "World RSS",
      collect: { method: "rss", rssUrl: "https://news.example.invalid/world/feed.xml" },
    });
    expect(rule?.item).toBeUndefined();
    await vi.waitFor(() =>
      expect(q(".rule.is-new .rule__status").textContent).toContain("3 items found on save"),
    );
    expect(t.sent).toEqual([]);
  });

  it("renders each health state with its chip and band", async () => {
    const base = { enabled: true, permissionGranted: true };
    const rules = {
      ok: { ...base, lastStatus: "ok", lastFetchedAt: NOW, lastItemCount: 18 },
      few: {
        ...base,
        lastStatus: "few-items",
        lastFetchedAt: NOW,
        lastItemCount: 2,
        typicalCount: 12,
      },
      broken: {
        ...base,
        lastStatus: "broken",
        lastFetchedAt: NOW,
        lastItemCount: 0,
        consecutiveZero: 3,
        lastSuccessAt: "2026-10-12T09:05:00.000Z",
        lastSuccessCount: 25,
      },
      perm: { ...base, permissionGranted: false },
      off: { ...base, enabled: false },
      visible: { ...base, lastStatus: "visible-tab", lastFetchedAt: NOW },
    } as const;
    for (const [name, state] of Object.entries(rules)) {
      const rule = siteRule({
        id: `${name}.example.invalid`,
        name,
        url: `https://${name}.example.invalid/`,
        match: [`${name}.example.invalid/*`],
      });
      await saveSiteRule(t.local, rule);
      await updateSiteState(t.local, rule.id, state);
    }
    await t.section.refresh();
    const row = (name: string): HTMLElement =>
      q(`.rule[aria-labelledby^="rn-${name}-example-invalid"]`);
    expect(row("ok").querySelector(".chip")?.textContent).toBe("Working");
    expect(row("few").querySelector(".rule__status")?.textContent).toContain(
      "2 items (usually 12)",
    );
    expect(row("broken").querySelector(".chip")?.textContent).toBe("Rule broken");
    expect(row("broken").querySelector(".rule__band")?.textContent).toContain("found 25 items");
    expect(row("broken").querySelector(".rule__band [data-act='repick']")).not.toBeNull();
    expect(row("perm").querySelector(".rule__band [data-act='perm']")?.textContent).toBe(
      "Allow",
    );
    expect(row("off").classList.contains("is-off")).toBe(true);
    expect(row("visible").querySelector("[data-act='collect-visible']")).not.toBeNull();
    expect(q("ul.rules").getAttribute("aria-label")).toBe("Sites, 6 rules");
  });

  it("deletes at once, undoes within the window, and gives the permission back when final", async () => {
    const rule = siteRule();
    await saveSiteRule(t.local, rule);
    await updateSiteState(t.local, rule.id, {
      enabled: true,
      permissionGranted: true,
      lastStatus: "ok",
      lastItemCount: 4,
    });
    await t.section.refresh();
    click(q("[data-act='delete']"));
    await vi.waitFor(() => expect(q(".toast").hidden).toBe(false));
    expect(await loadSiteRules(t.local)).toEqual([]);
    expect(document.activeElement?.id).toBe("add-btn");
    click(q(".toast button"));
    await vi.waitFor(async () => expect(await loadSiteRules(t.local)).toHaveLength(1));
    expect((await loadSiteStates(t.local))[rule.id]).toMatchObject({ lastItemCount: 4 });
    expect(t.permissions.removed).toEqual([]);

    click(q("[data-act='delete']"));
    await vi.waitFor(() =>
      expect(t.permissions.removed).toEqual([["https://news.example.invalid/*"]]),
    );
  });

  it("imports: lists schema errors, refuses duplicates, then asks permission and tests once", async () => {
    await saveSiteRule(t.local, siteRule());
    await t.section.refresh();
    click(q(".toolbar [data-act='import']"));
    const text = q<HTMLTextAreaElement>(".dlg textarea:not([readonly])");
    const form = q<HTMLFormElement>("#imp-form");
    type(text, '{ "nmcRule": 1, "id": "a", "name": "A", "url": "https://a.example.invalid/" }');
    submit(form);
    expect(q("#imp-res").textContent).toContain("Could not add:");
    expect(q("#imp-res li").textContent).toMatch(/^match/);
    expect(text.getAttribute("aria-invalid")).toBe("true");

    type(text, serializeSiteRule({ ...siteRule(), id: "copy" }));
    submit(form);
    expect(q("#imp-res").textContent).toContain("There is already a rule for this address");

    const shared = siteRule({
      id: "forum.example.invalid/notices",
      name: "Forum",
      url: "https://forum.example.invalid/notices",
      match: ["forum.example.invalid/notices"],
    });
    type(text, serializeSiteRule(shared));
    submit(form);
    expect(t.permissions.requested.at(-1)).toEqual(["https://forum.example.invalid/*"]);
    await vi.waitFor(async () => expect(await loadSiteRules(t.local)).toHaveLength(2));
    expect((await loadSiteStates(t.local))[shared.id]).toMatchObject({
      permissionGranted: true,
      savedItemCount: 9,
    });
    expect(t.sent.at(-1)?.kind).toBe("site-probe");
    await vi.waitFor(() =>
      expect(q(".toast").textContent).toContain("tested on the page: 9 items"),
    );
  });

  it("imports but says the test did not run when the worker refuses it", async () => {
    refuse = true;
    click(q(".toolbar [data-act='import']"));
    type(
      q<HTMLTextAreaElement>(".dlg textarea:not([readonly])"),
      serializeSiteRule(siteRule()),
    );
    submit(q<HTMLFormElement>("#imp-form"));
    await vi.waitFor(async () => expect(await loadSiteRules(t.local)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(q(".toast").textContent).toContain(
        "added, but the test did not work: not allowed",
      ),
    );
  });

  it("exports the rule JSON without its state", async () => {
    const rule = siteRule();
    await saveSiteRule(t.local, rule);
    await updateSiteState(t.local, rule.id, {
      enabled: true,
      permissionGranted: true,
      lastItemCount: 4,
    });
    await t.section.refresh();
    click(q("[data-act='export']"));
    const json = q<HTMLTextAreaElement>(".dlg textarea[readonly]").value;
    expect(JSON.parse(json)).toMatchObject({ nmcRule: 1, id: rule.id });
    expect(json).not.toContain("lastItemCount");
  });

  it("toggling a site keeps focus on its switch", async () => {
    await saveSiteRule(t.local, siteRule());
    await updateSiteState(t.local, siteRule().id, { enabled: true, permissionGranted: true });
    await t.section.refresh();
    const toggle = q<HTMLInputElement>("[data-act='toggle']");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(async () =>
      expect((await loadSiteStates(t.local))[siteRule().id]?.enabled).toBe(false),
    );
    await vi.waitFor(() => expect(q(".rule").classList.contains("is-off")).toBe(true));
    expect((document.activeElement as HTMLElement | null)?.dataset["act"]).toBe("toggle");
  });

  it("highlights the rule the picker just saved and focuses its switch", async () => {
    await saveSiteRule(t.local, siteRule());
    await t.session.set({ "nmc.siteNewRule": siteRule().id });
    await t.section.refresh();
    expect(q(".rule").classList.contains("is-new")).toBe(true);
    expect((document.activeElement as HTMLElement | null)?.dataset["act"]).toBe("toggle");
    expect(t.session.data["nmc.siteNewRule"]).toBeUndefined();
  });
});
