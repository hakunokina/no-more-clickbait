import { genericItemIdFromText, genericItemIdFromUrl } from "../feed-item.js";
import type { GenericItem } from "../schemas.js";
import {
  documentBase,
  MAX_AUTHOR_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  normalizeText,
  resolveHttpUrl,
  selectAll,
  visibleText,
  type DomElement,
  type DomQueryRoot,
} from "./dom.js";
import {
  RULE_FIELD_NAMES,
  type RuleField,
  type RuleFieldName,
  type SiteRule,
} from "./site-rule.js";

/**
 * The rule engine: one page (or any DOM root) + one rule → generic
 * items. The same code serves the picker's preview (live tab), static
 * collection (offscreen `DOMParser` document) and hidden-window
 * collection, so what the user previewed is what gets collected. It
 * reads the DOM only — no class, no style, no node is changed.
 */

export interface ExtractStats {
  /** Cards the item selector matched. */
  matched: number;
  /** Of those, dropped by `item.exclude`. */
  excluded: number;
  /** Dropped as a repeat of an earlier card (same id). */
  duplicates: number;
  /** Dropped for having neither title nor text. */
  empty: number;
  /** Items returned. */
  items: number;
  /** Per field: how many returned items have it. */
  coverage: Record<RuleFieldName, number>;
  /** Selectors the DOM rejected; each is skipped, never thrown. */
  invalidSelectors: string[];
}

export interface ExtractResult {
  items: GenericItem[];
  stats: ExtractStats;
}

export interface ExtractOptions {
  /**
   * The address the root was loaded from (relative links resolve
   * against it, or against its `<base href>`). Default: `rule.url`.
   */
  pageUrl?: string;
}

/** The source label every item of a rule carries. */
export function ruleSourceLabel(rule: Pick<SiteRule, "name">): string {
  return `custom:${rule.name}`;
}

/**
 * The rule's cards in `root`, in document order, with excluded ones
 * left out. The picker highlights exactly these.
 */
export function matchCards(
  root: DomQueryRoot,
  item: NonNullable<SiteRule["item"]>,
): { cards: DomElement[]; matched: number; excluded: number; invalidSelectors: string[] } {
  const invalidSelectors: string[] = [];
  const found = selectAll(root, item.selector);
  if (!found.ok)
    return { cards: [], matched: 0, excluded: 0, invalidSelectors: [item.selector] };
  const excludes = item.exclude.filter((selector) => {
    if (found.elements.length === 0 || isValidOn(found.elements[0]!, selector)) return true;
    invalidSelectors.push(selector);
    return false;
  });
  const cards = found.elements.filter((card) => !excludes.some((ex) => card.matches(ex)));
  return {
    cards,
    matched: found.elements.length,
    excluded: found.elements.length - cards.length,
    invalidSelectors,
  };
}

function isValidOn(element: DomElement, selector: string): boolean {
  try {
    element.matches(selector);
    return true;
  } catch {
    return false;
  }
}

export function extractItems(
  root: DomQueryRoot,
  rule: SiteRule,
  options: ExtractOptions = {},
): ExtractResult {
  const coverage = Object.fromEntries(RULE_FIELD_NAMES.map((name) => [name, 0])) as Record<
    RuleFieldName,
    number
  >;
  const stats: ExtractStats = {
    matched: 0,
    excluded: 0,
    duplicates: 0,
    empty: 0,
    items: 0,
    coverage,
    invalidSelectors: [],
  };
  if (!rule.item) return { items: [], stats };

  const pageUrl = resolveHttpUrl(options.pageUrl, rule.url) ?? rule.url;
  const base = documentBase(root, pageUrl);
  const { cards, matched, excluded, invalidSelectors } = matchCards(root, rule.item);
  stats.matched = matched;
  stats.excluded = excluded;
  const invalid = new Set(invalidSelectors);
  const fields = rule.fields ?? {};
  const sourceLabel = ruleSourceLabel(rule);
  const seen = new Set<string>();
  const items: GenericItem[] = [];

  for (const card of cards) {
    const skip = new Set<DomElement>();
    for (const selector of rule.exclude.within) {
      const found = selectAll(card, selector);
      if (found.ok) for (const el of found.elements) skip.add(el);
      else invalid.add(selector);
    }
    const pick = (field: RuleField | undefined): DomElement | undefined => {
      if (!field) return undefined;
      if (field.selector === ":scope") return card;
      try {
        const el = card.querySelector(field.selector);
        return el && !skip.has(el) ? el : undefined;
      } catch {
        invalid.add(field.selector);
        return undefined;
      }
    };

    const titleEl = pick(fields.title);
    const title = titleEl
      ? readText(titleEl, fields.title?.attr, skip, MAX_TITLE_CHARS)
      : undefined;
    const textEl = pick(fields.text);
    const text = textEl ? readText(textEl, fields.text?.attr, skip, MAX_TEXT_CHARS) : undefined;
    if (!title && !text) {
      stats.empty += 1;
      continue;
    }

    const linkEl = pick(fields.link);
    const rawLink = fields.link
      ? linkEl && readLink(linkEl, card, fields.link.attr, base)
      : // No link field: the title's own link, else the card's first.
        ((titleEl && readLink(titleEl, card, undefined, base)) ??
        readLink(card, card, undefined, base));
    const link = rawLink && withoutTracking(rawLink);
    const authorEl = pick(fields.author);
    const author = authorEl
      ? readText(authorEl, fields.author?.attr, skip, MAX_AUTHOR_CHARS)
      : undefined;
    const timeEl = pick(fields.time);
    const publishedAt = timeEl ? readTime(timeEl, fields.time?.attr, skip) : undefined;
    const imageEl = pick(fields.image);
    const image = imageEl ? readImage(imageEl, fields.image?.attr, base) : undefined;

    const id = link
      ? genericItemIdFromUrl(link)
      : genericItemIdFromText(`${title ?? ""}\n${text ?? ""}`);
    if (seen.has(id)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(id);

    const url = link ?? pageUrl;
    const item: GenericItem = {
      platform: "generic",
      id,
      sourceLabel,
      url,
      domain: new URL(url).hostname,
      promoted: false,
    };
    if (title) item.title = title;
    if (text) item.text = text;
    if (author) item.author = author;
    if (publishedAt) item.publishedAt = publishedAt;
    if (image) item.image = { url: image };
    items.push(item);

    if (title) coverage.title += 1;
    if (text) coverage.text += 1;
    if (fields.link && link) coverage.link += 1;
    if (author) coverage.author += 1;
    if (publishedAt) coverage.time += 1;
    if (image) coverage.image += 1;
  }

  stats.items = items.length;
  stats.invalidSelectors = [...invalid];
  return { items, stats };
}

/** Click-tracking parameters: the same story under two campaigns is one item. */
const TRACKING_PARAM = /^(?:utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid)$/i;

/** `url` without click-tracking query parameters (other parameters may be the page's id). */
export function withoutTracking(url: string): string {
  const parsed = new URL(url);
  const names = [...parsed.searchParams.keys()];
  if (!names.some((name) => TRACKING_PARAM.test(name))) return url;
  for (const name of names) if (TRACKING_PARAM.test(name)) parsed.searchParams.delete(name);
  return parsed.href;
}

function readText(
  el: DomElement,
  attr: string | undefined,
  skip: ReadonlySet<DomElement>,
  max: number,
): string | undefined {
  const raw = attr ? (el.getAttribute(attr) ?? "") : visibleText(el, skip);
  return normalizeText(raw, max) || undefined;
}

/**
 * An http(s) link for `el`: its `attr` (default href); else the nearest
 * linking ancestor up to the card; else its first link inside.
 */
function readLink(
  el: DomElement,
  card: DomElement,
  attr: string | undefined,
  base: string,
): string | undefined {
  if (attr) return resolveHttpUrl(el.getAttribute(attr), base);
  for (let node: DomElement | null = el; node; node = node.parentElement) {
    const href = resolveHttpUrl(node.getAttribute("href"), base);
    if (href) return href;
    if (node === card) break;
  }
  try {
    return resolveHttpUrl(el.querySelector("a[href]")?.getAttribute("href"), base);
  } catch {
    return undefined;
  }
}

/** ISO time from `attr`, else the `datetime` attribute, else the text; unparsable → none. */
function readTime(
  el: DomElement,
  attr: string | undefined,
  skip: ReadonlySet<DomElement>,
): string | undefined {
  const raw = attr
    ? el.getAttribute(attr)
    : (el.getAttribute("datetime") ?? normalizeText(visibleText(el, skip), 100));
  if (!raw?.trim()) return undefined;
  const time = Date.parse(raw.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function readImage(el: DomElement, attr: string | undefined, base: string): string | undefined {
  const candidates = attr ? [attr] : ["src", "data-src", "srcset", "data-srcset"];
  for (const name of candidates) {
    const raw = el.getAttribute(name);
    const value = name.endsWith("srcset") ? largestFromSrcset(raw) : raw;
    const url = resolveHttpUrl(value, base);
    if (url) return url;
  }
  if (!attr && el.tagName.toUpperCase() !== "IMG") {
    try {
      const img = el.querySelector("img");
      if (img) return readImage(img, undefined, base);
    } catch {
      // Not reachable with a constant selector; keep the field empty.
    }
  }
  return undefined;
}

/** The widest candidate of a srcset ("a.jpg 320w, b.jpg 640w" → "b.jpg"); else the first. */
function largestFromSrcset(srcset: string | null): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; width: number } | undefined;
  for (const candidate of srcset.split(",")) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    const width = descriptor?.endsWith("w") ? Number.parseInt(descriptor, 10) : 0;
    if (!best || width > best.width) best = { url, width: Number.isNaN(width) ? 0 : width };
  }
  return best?.url;
}
