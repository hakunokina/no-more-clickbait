import { genericItemIdFromUrl } from "../feed-item.js";
import {
  MAX_AUTHOR_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  normalizeText,
  resolveHttpUrl,
} from "../rules/dom.js";
import type { GenericItem } from "../schemas.js";
import {
  childElement,
  childElements,
  fromCodePoint,
  localName,
  parseXml,
  xmlText,
  type XmlElement,
} from "./xml.js";

/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom → generic items. A site's own feed is
 * the sturdiest way to follow it: no selectors to break, no page to
 * render. Feed text is untrusted like any page text; HTML in it is
 * reduced to plain text here and never rendered as markup.
 */

export class FeedParseError extends Error {
  override name = "FeedParseError";
}

export interface ParseFeedOptions {
  /** `GenericItem.sourceLabel`, e.g. `custom:<rule name>`. */
  sourceLabel: string;
  /** Where the feed was fetched from; relative links resolve against it. */
  feedUrl: string;
}

/**
 * Items in feed order, deduped by id. An entry without an http(s) link
 * or without both title and text is left out. Throws `FeedParseError`
 * when the XML is broken or is not a feed.
 */
export function parseFeed(xml: string, options: ParseFeedOptions): GenericItem[] {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    throw new FeedParseError(`not well-formed XML: ${(error as Error).message}`);
  }
  const kind = localName(root.name);
  let entries: Entry[];
  if (kind === "rss") {
    const channel = childElement(root, "channel");
    entries = channel ? childElements(channel, "item").map(rssEntry) : [];
  } else if (kind === "RDF") {
    entries = childElements(root, "item").map(rssEntry);
  } else if (kind === "feed") {
    entries = childElements(root, "entry").map(atomEntry);
  } else {
    throw new FeedParseError(`not an RSS or Atom feed (root element <${root.name}>)`);
  }

  const items: GenericItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = resolveHttpUrl(entry.link, options.feedUrl);
    const title = normalizeText(entry.title, MAX_TITLE_CHARS);
    const text = normalizeText(entry.text, MAX_TEXT_CHARS);
    if (!url || (!title && !text)) continue;
    const id = genericItemIdFromUrl(url);
    if (seen.has(id)) continue;
    seen.add(id);
    const item: GenericItem = {
      platform: "generic",
      id,
      sourceLabel: options.sourceLabel,
      url,
      domain: new URL(url).hostname,
      promoted: false,
    };
    if (title) item.title = title;
    if (text) item.text = text;
    const author = normalizeText(entry.author, MAX_AUTHOR_CHARS);
    if (author) item.author = author;
    const publishedAt = isoTime(entry.time);
    if (publishedAt) item.publishedAt = publishedAt;
    const image = resolveHttpUrl(entry.image, url);
    if (image) item.image = { url: image };
    items.push(item);
  }
  return items;
}

interface Entry {
  title: string;
  text: string;
  link: string | undefined;
  author: string;
  time: string;
  image: string | undefined;
}

function rssEntry(item: XmlElement): Entry {
  const description = xmlText(childElement(item, "description"));
  const content = xmlText(childElement(item, "content:encoded"));
  const guid = childElement(item, "guid");
  const guidText = guid ? xmlText(guid).trim() : "";
  // An opaque guid ("post-123", isPermaLink missing or "false") is an id,
  // not an address: resolving it against the feed URL would fabricate an
  // item URL (and RSS 2.0's "isPermaLink defaults to true" is not honored
  // by feeds in the wild, which carry opaque ids there). Only an absolute
  // http(s) guid backs the link. An entry left without any link is
  // skipped below: GenericItem.url is required, so unlike a rule card
  // (which falls back to the page URL) there is no linkless feed item.
  const guidLink =
    guid && guid.attrs.isPermaLink !== "false" && isAbsoluteHttpUrl(guidText)
      ? guidText
      : undefined;
  const atomLink = childElements(item, "link").find((el) => el.attrs.href)?.attrs.href;
  return {
    // RSS titles are plain text, but feeds often carry entity-escaped markup in them.
    title: decodeHtmlEntities(xmlText(childElement(item, "title"))),
    text: htmlToText(description || content),
    link: xmlText(childElement(item, "link")).trim() || atomLink || guidLink,
    author: rssAuthor(
      xmlText(childElement(item, "dc:creator")) || xmlText(childElement(item, "author")),
    ),
    time: xmlText(childElement(item, "pubDate")) || xmlText(childElement(item, "dc:date")),
    image: mediaImage(item) ?? firstImageIn(description || content),
  };
}

/** "jane@example.com (Jane Doe)" → "Jane Doe"; a bare address is dropped. */
function rssAuthor(raw: string): string {
  const named = /\(([^)]+)\)\s*$/.exec(raw);
  if (named?.[1]) return named[1];
  return /^\S+@\S+$/.test(raw.trim()) ? "" : raw;
}

/** True when `value` is already an absolute http(s) URL (no base to resolve against). */
function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^\s*https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function atomEntry(entry: XmlElement): Entry {
  const links = childElements(entry, "link");
  const alternate =
    links.find(
      (l) => (l.attrs.rel ?? "alternate") === "alternate" && l.attrs.type === "text/html",
    ) ?? links.find((l) => (l.attrs.rel ?? "alternate") === "alternate");
  const enclosure = links.find(
    (l) => l.attrs.rel === "enclosure" && (l.attrs.type ?? "").startsWith("image/"),
  );
  const summary = childElement(entry, "summary");
  const content = childElement(entry, "content");
  const body = summary ?? content;
  const author = childElement(entry, "author");
  return {
    title: atomText(childElement(entry, "title")),
    text: atomText(body),
    link: alternate?.attrs.href,
    author: author ? xmlText(childElement(author, "name")) : "",
    time: xmlText(childElement(entry, "published")) || xmlText(childElement(entry, "updated")),
    image:
      enclosure?.attrs.href ??
      mediaImage(entry) ??
      (body && body.attrs.type !== "text" ? firstImageIn(xmlText(body)) : undefined),
  };
}

/** Atom text constructs: "text" as is, "html" reduced to text, "xhtml" by its text nodes. */
function atomText(el: XmlElement | undefined): string {
  if (!el) return "";
  const type = el.attrs.type ?? "text";
  if (type === "html") return htmlToText(xmlText(el));
  return xmlText(el);
}

/** media:content / media:thumbnail (also inside media:group), RSS enclosure, itunes:image. */
function mediaImage(el: XmlElement): string | undefined {
  for (const child of childElements(el)) {
    const name = localName(child.name);
    const type = child.attrs.type ?? "";
    if (name === "enclosure" && type.startsWith("image/") && child.attrs.url)
      return child.attrs.url;
    if (name === "thumbnail" && child.attrs.url) return child.attrs.url;
    if (
      name === "content" &&
      child.attrs.url &&
      (child.attrs.medium === "image" || type.startsWith("image/"))
    ) {
      return child.attrs.url;
    }
    if (name === "group") {
      const nested = mediaImage(child);
      if (nested) return nested;
    }
    if (name === "image" && child.name.startsWith("itunes:") && child.attrs.href) {
      return child.attrs.href;
    }
  }
  return undefined;
}

function firstImageIn(html: string): string | undefined {
  let found: string | undefined;
  scanHtml(html, {
    text: () => undefined,
    tag: (tag) => {
      if (found || !/^img\b/i.test(tag)) return;
      const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      found = src?.[1] ?? src?.[2];
    },
  });
  return found ? decodeHtmlEntities(found) : undefined;
}

function isoTime(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * HTML (a feed's description/content) → plain text: scripts, styles
 * and tags dropped, block breaks kept as spaces, entities decoded.
 * Text only — the result is never treated as markup.
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  scanHtml(html, {
    text: (text) => parts.push(text),
    tag: (tag) => {
      if (BLOCK_TAG.test(tag)) parts.push(" ");
    },
  });
  return decodeHtmlEntities(parts.join(""));
}

const BLOCK_TAG =
  /^\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|tr|td|th|figure|figcaption|section|article)\b/i;

/** HTML read per entry; a hostile feed's megabyte description stops here. */
const MAX_HTML_CHARS = 100_000;

/**
 * One linear pass over HTML: text runs and tag bodies (between "<" and
 * ">") in order; comments and script/style/template contents skipped.
 * Hand-rolled rather than regex replaces so that unclosed "<!--" or
 * "<script" repeated many times cannot make it quadratic.
 */
function scanHtml(
  input: string,
  on: { text: (text: string) => void; tag: (tag: string) => void },
): void {
  const html = input.slice(0, MAX_HTML_CHARS);
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      on.text(html.slice(i));
      return;
    }
    if (lt > i) on.text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) return;
      on.text(" ");
      i = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) return;
    const tag = html.slice(lt + 1, gt);
    const raw = /^(script|style|template)\b/i.exec(tag)?.[1];
    if (raw) {
      const close = lower.indexOf(`</${raw.toLowerCase()}`, gt + 1);
      if (close < 0) return;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd < 0) return;
      on.text(" ");
      i = closeEnd + 1;
      continue;
    }
    on.tag(tag);
    i = gt + 1;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

/** Common named entities and numeric references; unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) return fromCodePoint(ref, whole);
    return HTML_ENTITIES[ref] ?? HTML_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}
