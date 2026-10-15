import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isGenericItem,
  isInstagramPost,
  TimelineDocSchema,
  type GenericItem,
  type InstagramPost,
  type TimelineCard,
  type TimelineDoc,
} from "@nmc/core";
import { describe, expect, it } from "vitest";
import { CARDS_SCRIPT, TIMELINE_SCRIPT } from "./client-script.js";
import { renderTimeline, TIMELINE_CSP } from "./render.js";
import { stateDocs } from "./state-docs.js";
import { CARDS_CSS, TIMELINE_CSS } from "./styles.js";

const load = (name: string) =>
  TimelineDocSchema.parse(
    JSON.parse(readFileSync(new URL(`../../core/fixtures/${name}`, import.meta.url), "utf8")),
  );
const mixed = load("timeline-doc-mixed.json");
const xOnly = load("timeline-doc.json");
const render = (doc: TimelineDoc) => renderTimeline(doc, { timeZone: "Europe/Istanbul" });
const count = (html: string, needle: string) => html.split(needle).length - 1;
const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const csp = (html: string) =>
  html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1] ?? "";
const article = (html: string, id: string) =>
  html.match(new RegExp(`<article [^>]*id="${id}"[\\s\\S]*?</article>`))?.[0] ?? "";
/** The first tag carrying an on* attribute (quoted values blanked). */
const handlerAttribute = (html: string) =>
  html.replace(/"[^"]*"/g, '""').match(/<[a-z][^>]*\son[a-z]+\s*=/i)?.[0];

function cardOf<T>(guard: (post: TimelineCard["post"]) => boolean): TimelineCard & { post: T } {
  const card = mixed.cards.find((c) => guard(c.post));
  if (!card) throw new Error("fixture lacks the card kind");
  return card as TimelineCard & { post: T };
}
const igCard = cardOf<InstagramPost>(isInstagramPost);
const genCard = cardOf<GenericItem>(isGenericItem);

/** A one-card doc (schema bypassed on purpose: the renderer must hold on its own). */
function single(card: TimelineCard): TimelineDoc {
  return {
    ...mixed,
    cards: [{ ...card, rank: 1 }],
    header: { ...mixed.header, timelineSize: 1 },
    funnel: mixed.funnel && { ...mixed.funnel, shown: 1 },
    status: { state: "ok" },
  };
}

describe("mixed feed", () => {
  const html = render(mixed);

  it("renders X, Instagram and generic cards (snapshot)", async () => {
    await expect(html).toMatchFileSnapshot("./__snapshots__/timeline-doc-mixed.html");
  });

  it("drops no card: one article per card, the counts agree", () => {
    const n = mixed.cards.length;
    expect(count(html, "<article")).toBe(n);
    expect(count(html, 'class="post post--ig"')).toBe(2);
    expect(count(html, 'class="post post--gen"')).toBe(2);
    expect(count(html, `aria-setsize="${n}"`)).toBe(n);
    expect(html).toContain(`aria-label="Akış, ${n} gönderi"`);
    expect(html).toContain(`<b>${n} gönderi</b>`);
    expect(html).toMatch(new RegExp(`Gösterilen</span></dt><dd>${mixed.funnel?.shown}</dd>`));
    expect(mixed.funnel?.shown).toBe(n);
    expect(html).toContain(`<span id="progress-of"> / ${n}</span>`);
    // 82 words + 2 X photos… : the minutes come from the doc's wordCount plus media glances.
    expect(html).toMatch(/≈ \d+ dk okuma/);
    const ids = (html.match(/ id="[^"]+"/g) ?? []).map((a) => a.slice(5, -1));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts a source line on X and Instagram cards only, and names the sources", () => {
    expect(count(html, '<div class="src">')).toBe(4);
    expect(article(html, "p1")).toContain('<span class="sr-only">Kaynak: </span>X</span>');
    expect(article(html, "p4")).toContain('<span class="sr-only">Kaynak: </span>Instagram</span>');
    expect(article(html, "p2")).not.toContain('class="src"');
    expect(html).toContain(
      "Kaynaklar: X, Reddit, news.example.invalid ve Instagram. Reklam, tekrar ve clickbait çıkarıldı.",
    );
  });

  it("adds the cards' style and script, and Instagram's CDNs, to its own CSP", () => {
    const css = TIMELINE_CSS + CARDS_CSS;
    const script = TIMELINE_SCRIPT + CARDS_SCRIPT;
    const policy = csp(html);
    expect(policy).toContain(
      "img-src https://pbs.twimg.com https://*.cdninstagram.com https://*.fbcdn.net data:",
    );
    expect(policy).toContain(
      "media-src https://video.twimg.com https://*.cdninstagram.com https://*.fbcdn.net",
    );
    expect(policy).toContain(`style-src ${hash(css)}`);
    expect(policy).toContain(`script-src ${hash(script)}`);
    expect(policy).not.toContain("unsafe");
    expect(html).toContain(`<style>${css}</style>`);
    expect(html).toContain(`<script>${script}</script>`);
    expect(count(html, "<script")).toBe(1);
    expect(html).not.toMatch(/\sstyle="/);
    expect(handlerAttribute(html)).toBeUndefined();
    expect(() => new Function(script)).not.toThrow();
  });

  it("keeps an X-only page exactly as before", () => {
    const page = render(xOnly);
    expect(csp(page)).toBe(TIMELINE_CSP);
    expect(page).not.toContain("cdninstagram");
    expect(page).not.toContain('class="src"');
    expect(page).not.toContain("Kaynaklar:");
    expect(page).not.toContain(CARDS_SCRIPT);
  });

  it("does not open Instagram's CDNs for a feed without Instagram cards", () => {
    const page = render(single(genCard));
    expect(csp(page)).toContain("img-src https://pbs.twimg.com data:");
    expect(csp(page)).not.toContain("cdninstagram");
    expect(page).toContain(`<style>${TIMELINE_CSS + CARDS_CSS}</style>`);
    // One platform: no source line, no source list.
    expect(page).not.toContain("Kaynaklar:");
  });

  it("keeps the states consistent with Instagram/generic cards in them", () => {
    const docs = stateDocs(mixed);
    expect(count(render(docs.short), "<article")).toBe(docs.short.cards.length);
    expect(render(docs.short)).toContain(`Bugün yalnız ${docs.short.cards.length} gönderi`);
    const empty = render(docs.empty);
    expect(count(empty, "<article")).toBe(0);
    expect(csp(empty)).toBe(TIMELINE_CSP);
  });
});

describe("Instagram card", () => {
  const card = render(single(igCard));
  const art = article(card, "p1");

  it("shows the handle, the carousel, the caption and the Instagram footer", () => {
    expect(art).toContain(
      '<a class="ig__handle" id="p1-name" href="https://www.instagram.com/synthetic_ig_1/"',
    );
    expect(art).toContain('aria-roledescription="carousel" aria-label="3 görsellik carousel"');
    expect(art).toContain('<span class="car__count" aria-hidden="true">1/3</span>');
    expect(count(art, " inert>")).toBe(2);
    expect(art).toContain('data-car-step="-1" aria-label="Önceki görsel" hidden>');
    expect(art).toContain('<div class="car__dots" aria-hidden="true"><i data-on></i><i></i><i></i></div>');
    // 1080×1350 = 4:5: every frame in the first frame's ratio.
    expect(count(art, 'viewBox="0 0 1000 1250"')).toBe(3);
    expect(art).toContain('<p class="ig__caption" id="p1-text" lang="und"><b>synthetic_ig_1</b> ');
    expect(art).toContain(">Instagram'da aç<");
    expect(art).toContain('href="https://www.instagram.com/p/SYNTHCAR01/"');
    expect(art).toContain('data-k="likes"');
    expect(art).not.toContain('data-k="views"');
    expect(art).not.toContain('class="src"');
  });

  it("falls back gracefully when a frame or the avatar does not load", () => {
    expect(count(art, '<p class="ig__fallback" aria-hidden="true">')).toBe(2);
    expect(art).toContain("Görsel yüklenemedi: Sentetik domates fideleri");
    expect(art).toMatch(/<img class="avatar" src="https:\/\/scontent\.cdninstagram\.com\/[^"]+"[^>]* data-fallback><span class="avatar avatar--h\d" aria-hidden="true" hidden>/);
  });

  it("plays a reel only when asked, in a 9:16 frame", () => {
    const reel = cardOf<InstagramPost>((p) => isInstagramPost(p) && p.kind === "reel");
    const out = article(render(single(reel)), "p1");
    expect(out).toContain('<div class="media ig__media reel-wrap"><div class="reel video" data-state="idle">');
    expect(out).toMatch(/<video width="1080" height="1920" preload="none" playsinline poster="https:\/\/scontent\.cdninstagram\.com\//);
    expect(out).toContain('<source src="https://scontent.cdninstagram.com/v/synthetic-spoon.mp4" type="video/mp4">');
    expect(out).toContain('aria-label="Reel&#39;i oynat, süre 0:42"');
    expect(out).toContain('data-k="views"');
    expect(out).not.toContain("autoplay");
  });

  it("clamps a long caption and offers 'Devamını oku'", () => {
    const out = article(
      render(single({ ...igCard, post: { ...igCard.post, caption: "söz ".repeat(60) } })),
      "p1",
    );
    expect(out).toContain('class="ig__caption is-clamped"');
    expect(out).toContain('aria-controls="p1-text">Devamını oku</button>');
  });

  it("drops media from hosts outside Instagram's CDNs and escapes the rest", () => {
    const evil = `<script>alert(1)</script>"'&`;
    const out = render(
      single({
        ...igCard,
        post: {
          ...igCard.post,
          authorHandle: `a"><svg onload=alert(2)>`,
          authorAvatarUrl: "https://cdn.evil.example/a.jpg",
          caption: evil,
          url: "javascript:alert(3)",
          media: [
            { type: "image", url: "https://scontent.cdninstagram.com.evil.example/1.jpg", altText: evil },
            { type: "image", url: "https://evilfbcdn.net/2.jpg" },
            { type: "image", url: "http://scontent.cdninstagram.com/3.jpg" },
            { type: "image", url: "https://scontent-ist1-1.cdninstagram.com/4.jpg", altText: evil },
            { type: "video", url: "https://cdn.evil.example/p.jpg", videoUrl: "https://cdn.evil.example/v.mp4" },
          ],
        },
      }),
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("evilfbcdn");
    expect(out).not.toContain("http://scontent");
    expect(out).toContain('src="https://scontent-ist1-1.cdninstagram.com/4.jpg"');
    expect(article(out, "p1")).not.toContain("data-car"); // one frame left: no carousel
    expect(out).not.toContain("<svg onload");
    expect(count(out, "<script")).toBe(1);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;");
    expect(handlerAttribute(out)).toBeUndefined();
    expect(out).not.toMatch(/(href|src|poster)="(?!https:)/);
    // Bad handle: no profile link; bad permalink: no "open on Instagram".
    expect(out).not.toContain("instagram.com/a");
    expect(article(out, "p1")).not.toContain("Instagram'da aç");
  });
});

describe("generic card", () => {
  const reddit = article(render(single(genCard)), "p1");
  const site = cardOf<GenericItem>((p) => isGenericItem(p) && p.sourceLabel !== "reddit");
  const custom = article(render(single(site)), "p1");

  it("leads with the place row and an uncut title (Reddit)", () => {
    expect(reddit).toContain('<span class="site-badge site-badge--reddit" aria-hidden="true">r/</span>');
    expect(reddit).toContain(
      '<span class="gen__place" id="p1-place"><span class="sr-only">Reddit, </span>r/synthetic_science</span>',
    );
    expect(reddit).toContain("u/synthetic_redditor");
    expect(reddit).toMatch(/<p class="gen__title" id="p1-title" lang="und">Sentetik/);
    expect(reddit).not.toContain("is-clamped");
    expect(reddit).toContain('aria-labelledby="p1-title" aria-describedby="p1-text"');
    // Reddit's own post: the place row already says where it is.
    expect(reddit).not.toContain("gen__domain");
    expect(reddit).toContain(">Kaynağa git<");
    expect(reddit).toContain('data-k="score"');
  });

  it("shows where a custom site's link goes, and never its image", () => {
    expect(custom).toContain(
      '<a class="gen__domain" href="https://news.example.invalid/ekonomi/sentetik-faiz-karari"',
    );
    expect(custom).toContain("<span>news.example.invalid</span>");
    expect(custom).toMatch(/<span class="site-badge avatar--h\d" aria-hidden="true">N<\/span>/);
    expect(custom).not.toContain("<img");
    expect(custom).not.toContain("sentetik-faiz.jpg");
    // No engagement on a custom site: no fake zeros.
    expect(custom).toContain('<ul class="stats" aria-label="Etkileşimler"></ul>');
  });

  it("writes zero and negative scores; names an untitled item by its place", () => {
    const out = article(
      render(
        single({
          ...genCard,
          post: {
            ...genCard.post,
            title: undefined,
            text: "uzun ".repeat(80),
            engagement: { score: -312, comments: 0 },
          },
        }),
      ),
      "p1",
    );
    expect(out).toContain("<span class=\"sr-only\">Puan: </span>−312</li>");
    expect(out).toContain("<span class=\"sr-only\">Yorum: </span>0</li>");
    expect(out).toContain('aria-labelledby="p1-place"');
    expect(out).toContain('class="gen__text gen__text--lead is-clamped"');
    expect(out).toContain("Devamını oku");
  });

  it("escapes hostile fields and links only https targets", () => {
    const evil = `<img src=x onerror=alert(1)>"'&`;
    const out = render(
      single({
        ...site,
        post: {
          ...site.post,
          title: evil,
          text: evil,
          author: evil,
          community: evil,
          domain: evil,
          url: "http://plain.example.invalid/a",
          image: { url: "https://pbs.twimg.com/media/not-for-generic.jpg" },
        },
      }),
    );
    expect(out).not.toContain("<img src=x");
    expect(handlerAttribute(out)).toBeUndefined();
    expect(out).not.toContain("http://plain.example.invalid");
    expect(out).not.toContain("not-for-generic");
    expect(article(out, "p1")).not.toContain("Kaynağa git");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
    expect(out).not.toMatch(/(href|src)="(?!https:)/);
  });
});
