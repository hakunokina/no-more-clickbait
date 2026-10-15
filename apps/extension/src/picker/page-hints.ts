import { selectorFor, UrlPatternSchema } from "@nmc/core";

/**
 * Hints the picker reads off the page for the rule's "more items" part
 * (patron: "daha fazla önerileri ok"): a "load more" button or a "next
 * page" link for the page method, and — once the user lets the picker
 * press that button — the page's own request behind it, for the
 * `request` method (listened to while browsing, never built).
 */

const LOAD_MORE_TEXT =
  /(?:load|show|see|view)\s+more|more\s+(?:stories|news|posts|articles|results)|older\s+posts|daha\s+fazla|devam[ıi]n[ıi]\s+g[öo]ster|y[üu]kle/i;
const NEXT_TEXT = /^(?:next(?:\s+page)?|older|sonraki(?:\s+sayfa)?|ileri|›|»|→)$/i;

export interface PaginationHints {
  loadMore?: { selector: string; label: string };
  nextPage?: { selector: string };
}

function visibleText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** A selector for `el` that matches it first in the document, or undefined. */
function selectorThatFinds(doc: Document, el: Element): string | undefined {
  const own = selectorFor(el);
  try {
    if (doc.querySelector(own) === el) return own;
  } catch {
    return undefined;
  }
  return undefined;
}

export function paginationHints(
  doc: Document,
  isPage: (el: Element) => boolean,
  cards: readonly Element[],
): PaginationHints {
  const inCard = (el: Element): boolean => cards.some((card) => card.contains(el));
  const hints: PaginationHints = {};
  for (const el of queryAll(doc, "button, a[href], [role='button']")) {
    if (!isPage(el) || inCard(el)) continue;
    const text = visibleText(el);
    if (text.length === 0 || text.length > 60 || !LOAD_MORE_TEXT.test(text)) continue;
    const selector = selectorThatFinds(doc, el);
    if (selector) {
      hints.loadMore = { selector, label: text };
      break;
    }
  }
  const relNext = queryAll(doc, 'a[rel~="next"][href]').find(isPage);
  if (relNext) {
    hints.nextPage = { selector: 'a[rel~="next"]' };
  } else {
    for (const el of queryAll(doc, "a[href]")) {
      if (!isPage(el) || inCard(el) || !NEXT_TEXT.test(visibleText(el))) continue;
      const selector = selectorThatFinds(doc, el);
      if (selector) {
        hints.nextPage = { selector };
        break;
      }
    }
  }
  return hints;
}

/** "host/path" for a request URL, when it fits the rule's pattern format. */
export function requestPatternFor(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const pattern = `${parsed.host.toLowerCase()}${path}`;
  return UrlPatternSchema.safeParse(pattern).success ? pattern : undefined;
}

export interface SeenResponse {
  url: string;
  contentType: string;
  bodyText: string;
}

export interface RequestCandidate {
  pattern: string;
  format: "html" | "json";
  /** Cards of the rule found in an HTML response. */
  cards: number;
}

/**
 * The response most likely to be the "more" request: same-origin, and an
 * HTML fragment holding the rule's cards (most cards wins); else the
 * first JSON response (noted as not readable yet).
 */
export function pickRequestCandidate(
  responses: readonly SeenResponse[],
  pageOrigin: string,
  cardSelector: string | null,
  parse: (html: string) => ParentNode,
): RequestCandidate | null {
  let best: RequestCandidate | null = null;
  let json: RequestCandidate | null = null;
  for (const response of responses) {
    let origin: string;
    try {
      origin = new URL(response.url).origin;
    } catch {
      continue;
    }
    if (origin !== pageOrigin) continue;
    const pattern = requestPatternFor(response.url);
    if (!pattern) continue;
    if (/json/i.test(response.contentType)) {
      json ??= { pattern, format: "json", cards: 0 };
      continue;
    }
    if (!cardSelector || !/html|text\/plain/i.test(response.contentType)) continue;
    const cards = queryAll(parse(response.bodyText), cardSelector).length;
    if (cards > 0 && (!best || cards > best.cards)) best = { pattern, format: "html", cards };
  }
  return best ?? json;
}
