import { documentBase, resolveHttpUrl, selectAll, type DomQueryRoot } from "../rules/dom.js";

export interface DiscoveredFeed {
  /** Absolute http(s) feed address. */
  url: string;
  kind: "rss" | "atom";
  /** The link's own title ("Gündem RSS"), when it has one. */
  title?: string;
}

const FEED_TYPES: Record<string, DiscoveredFeed["kind"]> = {
  "application/rss+xml": "rss",
  "application/rdf+xml": "rss",
  "application/atom+xml": "atom",
};

/**
 * The feeds a page announces (`<link rel="alternate" type="application/
 * rss+xml|atom+xml" href>`), in page order, without repeats. "Add site"
 * offers the first one instead of a picker: a feed needs no selectors.
 * `pageUrl` is the page's address (a parsed document's own base URL is
 * not trustworthy, see `documentBase`).
 */
export function discoverFeeds(root: DomQueryRoot, pageUrl: string): DiscoveredFeed[] {
  const links = selectAll(root, "link[rel][href][type]");
  if (!links.ok) return [];
  const base = documentBase(root, pageUrl);
  const feeds: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  for (const link of links.elements) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (link.getAttribute("type") ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
    const kind = FEED_TYPES[type];
    if (!rel.includes("alternate") || !kind) continue;
    const url = resolveHttpUrl(link.getAttribute("href"), base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = link.getAttribute("title")?.replace(/\s+/g, " ").trim();
    feeds.push(title ? { url, kind, title } : { url, kind });
  }
  return feeds;
}
