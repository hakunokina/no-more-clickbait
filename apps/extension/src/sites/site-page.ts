import type { ExtractStats, GenericItem, SiteRule } from "@nmc/core";
import type { PageCollectResult } from "./site-collect.js";

/**
 * The page method: the rule's page opens in a minimized window (Mode B
 * style), the rule runs inside it (site-content.ts, injected), the rule's
 * own pagination is driven (button / scroll / next page), then the
 * window closes. No request is ever built: whatever renders came from
 * the page's own flow. When nothing renders while hidden, the result
 * says `visible-tab` and the Sites row asks for a visible collect.
 * Only runs when the user chose the method and accepted its note.
 */

export interface OpenedPage {
  windowId: number;
  tabId: number;
}

export interface ExtractAnswer {
  items: GenericItem[];
  stats?: ExtractStats;
  hidden: boolean;
}

export interface PageBrowser {
  openHiddenPage(url: string): Promise<OpenedPage>;
  closePage(windowId: number): Promise<void>;
  /** Null when the tab is gone. */
  extractItems(tabId: number, rule: SiteRule): Promise<ExtractAnswer | null>;
  /** Pagination driver inside the tab; false when it did nothing. */
  drivePagination(
    tabId: number,
    action:
      | { type: "click"; selector: string }
      | { type: "scroll" }
      | { type: "next-page"; selector: string },
  ): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

const LOAD_POLL_MS = 1_000;
const LOAD_POLLS = 10;
const DRIVE_WAIT_MS = 2_500;

export async function collectViaPage(
  rule: SiteRule,
  browser: PageBrowser,
): Promise<PageCollectResult> {
  if (!rule.item) {
    return { ok: false, kind: "page-error", message: "The rule has no card selector." };
  }
  let opened: OpenedPage;
  try {
    opened = await browser.openHiddenPage(rule.url);
  } catch (error) {
    return {
      ok: false,
      kind: "page-error",
      message: `Could not open the page: ${String(error)}.`,
    };
  }
  try {
    let latest: ExtractAnswer | null = null;
    for (let i = 0; i < LOAD_POLLS; i += 1) {
      latest = await browser.extractItems(opened.tabId, rule).catch(() => null);
      if (latest && latest.items.length > 0) break;
      await browser.wait(LOAD_POLL_MS);
    }
    if (!latest) {
      return { ok: false, kind: "page-error", message: "The opened page stopped answering." };
    }
    latest = await driveRulePagination(opened.tabId, rule, latest, browser);
    if (latest.items.length === 0 && latest.hidden) {
      return {
        ok: false,
        kind: "visible-tab",
        message: "The page renders only in a visible tab.",
      };
    }
    return { ok: true, items: latest.items, ...(latest.stats ? { stats: latest.stats } : {}) };
  } finally {
    await browser.closePage(opened.windowId).catch(() => undefined);
  }
}

/** `page` mode: up to `maxPages` extractions, driving the rule's pagination between them. */
async function driveRulePagination(
  tabId: number,
  rule: SiteRule,
  first: ExtractAnswer,
  browser: PageBrowser,
): Promise<ExtractAnswer> {
  const pagination = rule.pagination;
  if (pagination.type === "none") return first;
  let latest = first;
  const rounds = Math.min(pagination.maxPages, 10);
  for (let i = 0; i < rounds; i += 1) {
    const action =
      pagination.type === "scroll"
        ? { type: "scroll" as const }
        : pagination.type === "load-more"
          ? { type: "click" as const, selector: pagination.selector }
          : { type: "next-page" as const, selector: pagination.selector };
    const drove = await browser.drivePagination(tabId, action).catch(() => false);
    if (!drove) break;
    await browser.wait(DRIVE_WAIT_MS);
    const next = await browser.extractItems(tabId, rule).catch(() => null);
    if (!next) break;
    latest = next;
  }
  return latest;
}

/** Sends to the rule script in the tab, injecting it first when the tab has none yet. */
async function askTab(tabId: number, message: unknown): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["site-content.js"] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Still loading, an error page, or closed: the caller polls again.
      return undefined;
    }
  }
}

/** The real browser behind `PageBrowser` (worker context). */
export const chromePageBrowser: PageBrowser = {
  async openHiddenPage(url: string): Promise<OpenedPage> {
    const created = await chrome.windows.create({ url, state: "minimized", focused: false });
    const windowId = created?.id;
    if (windowId === undefined) throw new Error("the browser returned no window");
    const tabId = created?.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId }))[0]?.id;
    if (tabId === undefined) throw new Error("the new window has no tab");
    return { windowId, tabId };
  },
  closePage: (windowId: number) => chrome.windows.remove(windowId),
  async extractItems(tabId: number, rule: SiteRule): Promise<ExtractAnswer | null> {
    const answer = (await askTab(tabId, { kind: "site-extract-query", rule })) as
      ExtractAnswer | undefined;
    return answer ?? null;
  },
  async drivePagination(tabId, action): Promise<boolean> {
    const answer = (await askTab(tabId, { kind: "site-extract-act", action })) as
      { drove?: boolean } | undefined;
    return answer?.drove === true;
  },
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
