import { SiteRuleSchema, type GenericItem, type SiteRule, type SiteRuleInput } from "@nmc/core";
import type { StorageArea } from "./site-store.js";

/** Synthetic fixtures for the Sites tests (example.invalid only, no real site). */

export function siteRule(overrides: Partial<SiteRuleInput> = {}): SiteRule {
  return SiteRuleSchema.parse({
    nmcRule: 1,
    id: "news.example.invalid/world",
    name: "News — World",
    url: "https://news.example.invalid/world",
    match: ["news.example.invalid/world/*"],
    item: { selector: "article.card" },
    fields: {
      title: { selector: "h2.title" },
      text: { selector: "p.summary" },
      link: { selector: "a.link", attr: "href" },
    },
    collect: { method: "auto" },
    health: { minItems: 3 },
    origin: "manual",
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  });
}

export function genericItem(id: string, sourceLabel = "custom:News — World"): GenericItem {
  return {
    platform: "generic",
    id,
    sourceLabel,
    title: `Synthetic headline ${id}`,
    url: `https://news.example.invalid/world/${id}`,
    domain: "news.example.invalid",
    promoted: false,
  };
}

/** A `chrome.storage` area in memory (values deep-copied like the real one). */
export class MemoryArea implements StorageArea {
  data: Record<string, unknown> = {};
  get(keys: string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys ?? Object.keys(this.data)) {
      if (key in this.data) out[key] = structuredClone(this.data[key]);
    }
    return Promise.resolve(out);
  }
  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data[key] = structuredClone(value);
    return Promise.resolve();
  }
  remove(keys: string[]): Promise<void> {
    for (const key of keys) delete this.data[key];
    return Promise.resolve();
  }
}

/** Synthetic news page: `count` cards (2 and 4 sponsored, 1 with an inline promo). */
export function newsPageHtml(count = 6): string {
  const cards = Array.from({ length: count }, (_, i) => {
    const sponsored = i === 2 || i === 4;
    const label = sponsored
      ? '<span class="sponsor">Sponsored</span>'
      : '<span class="kicker">City</span>';
    const promo = i === 1 ? ' <span class="promo">Subscribe to read on</span>' : "";
    return `<article class="card">
      <a class="media" href="/world/story-${i}"><img class="thumb" src="/img/${i}.svg" alt=""></a>
      <div class="body">
        ${label}
        <h2 class="title"><a class="link" href="/world/story-${i}">Synthetic headline ${i}</a></h2>
        <p class="summary">Synthetic summary ${i}.${promo}</p>
        <div class="meta"><span class="author">Writer ${i}</span> · <time datetime="2026-10-15T0${i}:00:00Z">${i} h ago</time></div>
      </div>
    </article>`;
  }).join("");
  return `<!doctype html><html><head><title>News</title>
    <link rel="alternate" type="application/rss+xml" title="World RSS" href="/world/feed.xml">
  </head><body>
    <header class="top"><nav class="nav"><a href="/world">World</a><a href="/sport">Sport</a></nav></header>
    <main class="main"><h1 class="h">World</h1><div class="list">${cards}</div>
      <button class="more" type="button">Load more stories</button></main>
    <aside class="aside"><ol><li><a href="/a/1">Most read 1</a></li><li><a href="/a/2">Most read 2</a></li></ol></aside>
  </body></html>`;
}

export const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>World</title>
  <item><title>Feed one</title><link>https://news.example.invalid/world/f1</link><description>One.</description></item>
  <item><title>Feed two</title><link>https://news.example.invalid/world/f2</link><description>Two.</description></item>
  <item><title>Feed three</title><link>https://news.example.invalid/world/f3</link><description>Three.</description></item>
</channel></rss>`;
