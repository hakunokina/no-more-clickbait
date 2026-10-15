import type {
  FeedItem,
  FeedPlatform,
  GenericItem,
  InstagramPost,
  XFeedPost,
} from "./schemas.js";

/**
 * Source-independent views of a `FeedItem`, so the pipeline stages that
 * do not care about the source (hard filter, selector, funnel) need no
 * per-source branches of their own.
 */

/** Which source an item came from; untagged items are X posts. */
export function platformOf(item: FeedItem): FeedPlatform {
  return item.platform ?? "x";
}

export function isXPost(item: FeedItem): item is XFeedPost {
  return item.platform === undefined || item.platform === "x";
}

export function isInstagramPost(item: FeedItem): item is InstagramPost {
  return item.platform === "instagram";
}

export function isGenericItem(item: FeedItem): item is GenericItem {
  return item.platform === "generic";
}

/**
 * The item's source as a tally reports it: "x", "instagram", or a
 * generic item's `sourceLabel` ("reddit", "custom:<rule name>", …).
 */
export function feedSourceLabel(item: FeedItem): string {
  return isGenericItem(item) ? item.sourceLabel : platformOf(item);
}

/**
 * The item's identity across every source in one run: what the hard
 * filter dedupes on and what `ScoreEntry.postId` / `VerificationResult.
 * postId` carry. An X post keeps its bare id (so X results read as
 * before); other ids are only unique within their source, so the source
 * is part of the key (components URI-encoded: a label such as
 * "custom:news" cannot make two keys collide).
 */
export function feedItemKey(item: FeedItem): string {
  if (isXPost(item)) return item.id;
  if (isInstagramPost(item)) return `instagram:${encodeURIComponent(item.id)}`;
  return `generic:${encodeURIComponent(item.sourceLabel)}:${encodeURIComponent(item.id)}`;
}

/**
 * True when the item has no text to judge (only media): the pipeline
 * passes it through unscored. X: the parser's `mediaOnly` flag; Instagram:
 * an empty caption; generic: neither title nor text.
 */
export function isMediaOnly(item: FeedItem): boolean {
  if (isXPost(item)) return item.mediaOnly === true;
  if (isInstagramPost(item)) return item.caption.trim() === "";
  return !item.title?.trim() && !item.text?.trim();
}

/** 32-bit FNV-1a over UTF-16 code units, from a given offset basis. */
function fnv1a(text: string, basis: number): number {
  let hash = basis;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable id for a generic item whose source gives none: a hash of its
 * URL without the fragment (the same page via "#comments" is the same
 * item). Not a security hash — only stable and spread out. Never
 * throws: a string that does not parse as a URL is hashed as given
 * (trimmed), so one malformed link cannot fail a whole batch.
 */
export function genericItemIdFromUrl(url: string): string {
  let href: string;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    href = parsed.href;
  } catch {
    href = url.trim();
  }
  return `u${hash64(href)}`;
}

/**
 * A stable id for a generic item with no link of its own (a custom rule
 * card without one): a hash of its text. Weaker than a URL id — the
 * same story with an edited summary is a new item.
 */
export function genericItemIdFromText(text: string): string {
  return `t${hash64(text)}`;
}

/** Two 32-bit FNV-1a hashes with different bases, as 16 hex digits. */
function hash64(text: string): string {
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return `${hex(fnv1a(text, 0x811c9dc5))}${hex(fnv1a(text, 0x050c5d1f))}`;
}
