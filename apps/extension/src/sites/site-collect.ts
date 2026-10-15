import {
  assessRuleHealth,
  feedItemKey,
  FeedParseError,
  parseFeed,
  ruleSourceLabel,
  type ExtractResult,
  type ExtractStats,
  type GenericItem,
  type SiteRule,
} from "@nmc/core";
import type { CollectVerdict } from "./site-store.js";

/**
 * One site's collection (design: rule-picker.md "Toplama"; leader
 * decisions #777/#779). `auto` walks the sturdiest paths first and never
 * opens a window:
 *
 *   RSS/Atom feed (when the rule has one) → static fetch of the page,
 *   parsed in the offscreen document by the same core engine as the
 *   picker's preview → the page's own "more" responses, captured while
 *   the user browsed the site (consumed once, merged without repeats).
 *
 * The page method (hidden minimized window) runs only when the user
 * chose it for the site and accepted its one-time note in Options; when
 * `auto` finds nothing on a page that never worked statically, the
 * verdict is "visible tab needed" instead of "broken".
 */

export type AttemptedMethod = "rss" | "static" | "request" | "page";

export type FetchResult =
  | { ok: true; text: string; finalUrl: string }
  | { ok: false; status?: number; message: string };

export type PageCollectResult =
  | { ok: true; items: GenericItem[]; stats?: ExtractStats }
  | { ok: false; kind: "visible-tab" | "page-error"; message: string };

export interface RequestBuffer {
  items: GenericItem[];
  lastAt?: string;
}

export interface CollectDeps {
  fetchText(url: string): Promise<FetchResult>;
  /** Parses fetched HTML and runs the rule engine on it (offscreen document in the worker). */
  extractStatic(html: string, pageUrl: string, rule: SiteRule): Promise<ExtractResult>;
  /** Takes (and empties) the site's captured "more" items. */
  takeRequestBuffer(siteId: string): Promise<RequestBuffer | null>;
  /** Opens the page in a hidden window and extracts there. */
  collectViaPage(rule: SiteRule): Promise<PageCollectResult>;
}

export interface CollectContext {
  /** The one-time page-method note was accepted in Options. */
  pageNoteAccepted: boolean;
  /** Static fetch has produced items for this rule before (save probe or a collect). */
  staticKnownGood: boolean;
}

export interface SiteCollectResult {
  /** The method whose items these are (the first one that answered). */
  method: AttemptedMethod;
  items: GenericItem[];
  verdict: CollectVerdict;
  stats?: ExtractStats;
  /** Plain detail for the row/outcome (HTTP status, parse error, …). */
  message?: string;
  /** Static fetch produced items this time. */
  staticWorked?: boolean;
}

/** The methods `auto` tries for a rule, in order (page is never one of them). */
export function autoChain(rule: Pick<SiteRule, "collect" | "item">): AttemptedMethod[] {
  const chain: AttemptedMethod[] = [];
  if (rule.collect.rssUrl) chain.push("rss");
  if (rule.item) chain.push("static");
  if (rule.item && rule.collect.request) chain.push("request");
  return chain;
}

export async function collectSite(
  rule: SiteRule,
  deps: CollectDeps,
  context: CollectContext,
): Promise<SiteCollectResult> {
  switch (rule.collect.method) {
    case "rss":
      return collectFeed(rule, deps);
    case "static": {
      const result = await collectStatic(rule, deps);
      return result.kind === "fetched" ? fromStats("static", result, rule) : result.result;
    }
    case "request":
      return collectRequest(rule, deps, []);
    case "page":
      return collectPage(rule, deps, context);
    case "auto":
      return collectAuto(rule, deps, context);
  }
}

async function collectAuto(
  rule: SiteRule,
  deps: CollectDeps,
  context: CollectContext,
): Promise<SiteCollectResult> {
  let fetchError: SiteCollectResult | undefined;
  let feed: SiteCollectResult | undefined;
  if (rule.collect.rssUrl) {
    feed = await collectFeed(rule, deps);
    if (feed.items.length > 0) return feed;
    if (feed.verdict === "fetch-error") fetchError = feed;
  }
  if (!rule.item) return feed ?? (await collectFeed(rule, deps));

  const fromPage = await collectStatic(rule, deps);
  const staticItems = fromPage.kind === "fetched" ? fromPage.items : [];
  if (fromPage.kind === "failed") fetchError ??= fromPage.result;

  if (rule.collect.request) {
    const merged = await collectRequest(rule, deps, staticItems);
    if (fromPage.kind === "fetched" && staticItems.length > 0) {
      // The page answered: its health decides, the captured "more" items ride along.
      const verdict = fromStats("static", fromPage, rule);
      return { ...verdict, items: merged.items, staticWorked: true };
    }
    if (merged.items.length > 0) return merged;
    if (merged.verdict === "json-unsupported") return merged;
  } else if (fromPage.kind === "fetched" && staticItems.length > 0) {
    return { ...fromStats("static", fromPage, rule), staticWorked: true };
  }

  if (fromPage.kind === "fetched") {
    // A page that has never worked statically is drawn by script: say so, never "broken".
    if (!context.staticKnownGood && fromPage.stats.invalidSelectors.length === 0) {
      return { method: "static", items: [], verdict: "visible-tab", stats: fromPage.stats };
    }
    return fromStats("static", fromPage, rule);
  }
  return fetchError ?? fromPage.result;
}

async function collectFeed(rule: SiteRule, deps: CollectDeps): Promise<SiteCollectResult> {
  const url = rule.collect.rssUrl;
  if (!url) {
    return {
      method: "rss",
      items: [],
      verdict: "broken",
      message: "The rule has no feed address.",
    };
  }
  const fetched = await deps.fetchText(url);
  if (!fetched.ok) {
    return {
      method: "rss",
      items: [],
      verdict: "fetch-error",
      message: describeFetch(fetched),
    };
  }
  try {
    const items = parseFeed(fetched.text, {
      sourceLabel: ruleSourceLabel(rule),
      feedUrl: fetched.finalUrl,
    });
    const verdict: CollectVerdict =
      items.length === 0 ? "broken" : items.length < rule.health.minItems ? "few-items" : "ok";
    return { method: "rss", items, verdict };
  } catch (error) {
    const detail = error instanceof FeedParseError ? error.message : String(error);
    return { method: "rss", items: [], verdict: "broken", message: detail };
  }
}

type StaticAttempt =
  | { kind: "fetched"; items: GenericItem[]; stats: ExtractStats }
  | { kind: "failed"; result: SiteCollectResult };

async function collectStatic(rule: SiteRule, deps: CollectDeps): Promise<StaticAttempt> {
  if (!rule.item) {
    return {
      kind: "failed",
      result: {
        method: "static",
        items: [],
        verdict: "broken",
        message: "The rule has no card.",
      },
    };
  }
  const fetched = await deps.fetchText(rule.url);
  if (!fetched.ok) {
    return {
      kind: "failed",
      result: {
        method: "static",
        items: [],
        verdict: "fetch-error",
        message: describeFetch(fetched),
      },
    };
  }
  try {
    const { items, stats } = await deps.extractStatic(fetched.text, fetched.finalUrl, rule);
    return { kind: "fetched", items, stats };
  } catch (error) {
    return {
      kind: "failed",
      result: { method: "static", items: [], verdict: "fetch-error", message: String(error) },
    };
  }
}

async function collectRequest(
  rule: SiteRule,
  deps: CollectDeps,
  before: GenericItem[],
): Promise<SiteCollectResult> {
  if (rule.collect.request?.format === "json") {
    return { method: "request", items: before, verdict: "json-unsupported" };
  }
  const buffer = await deps.takeRequestBuffer(rule.id);
  const items = mergeItems(before, buffer?.items ?? []);
  if (items.length === 0) {
    return { method: "request", items, verdict: "visible-tab" };
  }
  const verdict: CollectVerdict = items.length < rule.health.minItems ? "few-items" : "ok";
  return { method: "request", items, verdict };
}

async function collectPage(
  rule: SiteRule,
  deps: CollectDeps,
  context: CollectContext,
): Promise<SiteCollectResult> {
  if (!context.pageNoteAccepted) return { method: "page", items: [], verdict: "page-note" };
  const via = await deps.collectViaPage(rule);
  if (!via.ok) {
    return via.kind === "visible-tab"
      ? { method: "page", items: [], verdict: "visible-tab", message: via.message }
      : { method: "page", items: [], verdict: "fetch-error", message: via.message };
  }
  if (!via.stats) {
    const verdict: CollectVerdict =
      via.items.length === 0
        ? "broken"
        : via.items.length < rule.health.minItems
          ? "few-items"
          : "ok";
    return { method: "page", items: via.items, verdict };
  }
  return fromStats("page", { items: via.items, stats: via.stats }, rule);
}

/** Rule health (core) → the row verdict. */
function fromStats(
  method: AttemptedMethod,
  { items, stats }: { items: GenericItem[]; stats: ExtractStats },
  rule: SiteRule,
): SiteCollectResult {
  const health = assessRuleHealth(stats, rule);
  const result: SiteCollectResult = { method, items, verdict: health.status, stats };
  if (health.status !== "ok") result.message = health.reason;
  return result;
}

/** `before` first, then the new items whose key it does not have yet. */
export function mergeItems(before: GenericItem[], added: GenericItem[]): GenericItem[] {
  const seen = new Set(before.map(feedItemKey));
  const merged = [...before];
  for (const item of added) {
    const key = feedItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function describeFetch(fetched: { status?: number; message: string }): string {
  return fetched.status !== undefined ? `HTTP ${fetched.status}` : fetched.message;
}
