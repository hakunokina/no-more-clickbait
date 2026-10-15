import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TimelineDocSchema, type TimelineCard, type TimelineDoc } from "@nmc/core";
import { describe, expect, it } from "vitest";
import { TIMELINE_SCRIPT } from "./client-script.js";
import { renderTimeline, TIMELINE_CSP } from "./render.js";
import { stateDocs } from "./state-docs.js";
import { TIMELINE_CSS } from "./styles.js";

const fixture = TimelineDocSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../core/fixtures/timeline-doc.json", import.meta.url), "utf8"),
  ),
);
const render = (doc: TimelineDoc) => renderTimeline(doc, { timeZone: "Europe/Istanbul" });
const count = (html: string, needle: string | RegExp) =>
  typeof needle === "string"
    ? html.split(needle).length - 1
    : (html.match(needle) ?? []).length;
/** The first tag carrying an on* attribute (quoted values blanked: escaped text may say "onerror="). */
const handlerAttribute = (html: string) =>
  html.replace(/"[^"]*"/g, '""').match(/<[a-z][^>]*\son[a-z]+\s*=/i)?.[0];
const firstCard = fixture.cards[0] as TimelineCard;

/** One card replaced (schema bypassed on purpose: the renderer must hold on its own). */
function withCard(card: TimelineCard): TimelineDoc {
  return { ...fixture, cards: [card, ...fixture.cards.slice(1)] };
}

describe("renderTimeline", () => {
  it("renders the synthetic fixture (snapshot)", async () => {
    await expect(render(fixture)).toMatchFileSnapshot("./__snapshots__/timeline-doc.html");
  });

  it("allows only its own style and script, by hash", () => {
    const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");
    expect(TIMELINE_CSP).toContain("default-src 'none'");
    expect(TIMELINE_CSP).toContain("img-src https://pbs.twimg.com data:");
    expect(TIMELINE_CSP).toContain("media-src https://video.twimg.com");
    expect(TIMELINE_CSP).toContain(`style-src 'sha256-${hash(TIMELINE_CSS)}'`);
    expect(TIMELINE_CSP).toContain(`script-src 'sha256-${hash(TIMELINE_SCRIPT)}'`);
    expect(TIMELINE_CSP).not.toContain("unsafe");
    const html = render(fixture);
    expect(html).toContain(`<style>${TIMELINE_CSS}</style>`);
    expect(html).toContain(`<script>${TIMELINE_SCRIPT}</script>`);
    expect(html).not.toMatch(/\sstyle="/);
    expect(handlerAttribute(html)).toBeUndefined();
  });

  it("ships a script that parses", () => {
    expect(() => new Function(TIMELINE_SCRIPT)).not.toThrow();
  });

  it("escapes hostile post content and drops non-https URLs", () => {
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)></style>\"'&";
    const html = render(
      withCard({
        ...firstCard,
        post: {
          ...firstCard.post,
          authorName: `"><svg onload=alert(3)>`,
          authorHandle: "bad handle<",
          repostedBy: "<b>x</b>",
          text: `${evil} javascript:alert(4) https://ok.example.invalid/a"onmouseover="x`,
          url: "javascript:alert(5)",
          lang: 'en" onmouseover="alert(6)',
          media: [
            { type: "photo", url: "javascript:alert(7)", altText: evil },
            {
              type: "photo",
              url: "https://pbs.twimg.com/media/a.jpg",
              altText: evil,
              width: 10,
              height: 10,
            },
            { type: "link", url: "javascript:alert(8)" },
            {
              type: "link",
              url: "https://ok.example.invalid/b",
              card: { title: evil, description: evil },
            },
          ],
          quoted: { id: "1", authorHandle: "q", text: evil, authorName: evil },
        },
        score: { ...firstCard.score, reason: evil },
        verification: {
          postId: firstCard.post.id,
          claim: evil,
          status: "verified",
          confidence: 1,
          summary: evil,
          sources: [
            { url: "http://plain.example.invalid/", title: evil },
            { url: "https://src.example.invalid/", title: evil },
          ],
        },
      }),
    );
    expect(count(html, "<script")).toBe(1);
    expect(count(html, "</script>")).toBe(1);
    expect(count(html, "</style>")).toBe(1);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(handlerAttribute(html)).toBeUndefined();
    expect(html).not.toMatch(/(href|src)="(?!https:)/);
    expect(html).not.toContain("http://plain.example.invalid");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("alert(6)");
    // The bad handle gets no profile link and no "open on X" link.
    expect(html).not.toContain("x.com/bad");
    expect(html.match(/<article[\s\S]*?<\/article>/)?.[0]).not.toContain("X'te aç");
  });

  it("drops media from hosts outside X's CDNs", () => {
    const html = render(
      withCard({
        ...firstCard,
        post: {
          ...firstCard.post,
          authorAvatarUrl: "https://cdn.evil.example/avatar.jpg",
          media: [
            { type: "photo", url: "https://cdn.evil.example/p.jpg", width: 10, height: 10 },
            {
              type: "video",
              url: "https://cdn.evil.example/poster.jpg",
              variants: [{ url: "https://cdn.evil.example/v.mp4" }],
            },
            {
              type: "gif",
              url: "https://pbs.twimg.com/tweet_video_thumb/g.jpg",
              variants: [{ url: "https://cdn.evil.example/g.mp4" }],
            },
            {
              type: "link",
              url: "https://news.example.invalid/x",
              card: { title: "T", image: { url: "https://cdn.evil.example/card.jpg" } },
            },
          ],
        },
      }),
    );
    expect(html).not.toContain("cdn.evil.example");
    // The GIF without an allowed rendition falls back to its (allowed) still.
    expect(html).toContain('src="https://pbs.twimg.com/tweet_video_thumb/g.jpg"');
    expect(html).toContain('href="https://news.example.invalid/x"');
  });

  it("reserves media space and loads it lazily", () => {
    const html = render(fixture);
    for (const img of html.match(/<img [^>]*>/g) ?? []) {
      if (img.includes('id="lb-img"')) continue;
      expect(img).toContain('loading="lazy"');
    }
    expect(html).toContain('width="1600" height="900"');
    const video = html.match(/<video [^>]*>/g) ?? [];
    expect(video.length).toBeGreaterThan(0);
    for (const tag of video) {
      expect(tag).toContain('preload="none"');
      expect(tag).toMatch(/poster="https:\/\/pbs\.twimg\.com\//);
      expect(tag).toMatch(/width="\d+" height="\d+"/);
    }
    expect(html).toMatch(/<source src="https:\/\/video\.twimg\.com\/[^"]+" type="video\/mp4">/);
  });

  it("opens every outside link in a new window without opener or referrer", () => {
    const html = render(fixture);
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it("shows only the two verification states and no scores on the card face", () => {
    const html = render(fixture);
    expect(html).toContain("Doğrulandı");
    expect(html).toContain("Doğrulanamadı");
    expect(html).not.toContain("Kaynaklarla çelişiyor");
    expect(html).not.toContain("değmez");
    // Scores live behind "Neden burada?" only.
    const whyPanels = html.match(/<div class="why"[^>]*hidden>[\s\S]*?<\/div>/g) ?? [];
    expect(whyPanels).toHaveLength(fixture.cards.length);
    expect(html.replace(/<div class="why"[^>]*hidden>[\s\S]*?<\/div>/g, "")).not.toMatch(
      /\(0,\d\d\)/,
    );
  });

  it("keeps a contradicted post out of the feed and counts it in the tally", () => {
    const html = render(
      withCard({
        ...firstCard,
        post: { ...firstCard.post, text: "ÇELİŞEN GÖNDERİ METNİ" },
        verification: {
          postId: firstCard.post.id,
          claim: "c",
          status: "false_or_disputed",
          confidence: 0.9,
          summary: "s",
          sources: [{ url: "https://src.example.invalid/", title: "t" }],
        },
      }),
    );
    expect(html).not.toContain("ÇELİŞEN GÖNDERİ METNİ");
    expect(count(html, "<article")).toBe(fixture.cards.length - 1);
    expect(html).toMatch(
      /Kaynaklarla çelişen<span class="tally__hint">[^<]*<\/span><\/span><\/dt><dd>2<\/dd>/,
    );
  });

  describe("states", () => {
    const docs = stateDocs(fixture);

    it("ok: N cards, the intro, Done with a tally that adds up", () => {
      const html = render(docs.ok);
      expect(count(html, "<article")).toBe(6);
      expect(html).toContain('role="feed"');
      expect(html).toContain('aria-setsize="6"');
      expect(html).not.toContain(`class="short-note"`);
      expect(html).toContain('<h2 id="done-h">Bitti</h2>');
      expect(html).toContain("Taranan");
      expect(html).toMatch(/Gösterilen<\/span><\/dt><dd>6<\/dd>/);
      expect(html).toMatch(/Sıraya giremeyen/);
    });

    it("short: the honest note above fewer cards", () => {
      const html = render(docs.short);
      expect(count(html, "<article")).toBe(3);
      expect(html).toContain("Bugün yalnız 3 gönderi eşiği geçti (hedef 6)");
      expect(html).not.toMatch(/Sıraya giremeyen/);
    });

    it("empty: straight to Done, shown 0", () => {
      const html = render(docs.empty);
      expect(count(html, "<article")).toBe(0);
      expect(html).not.toContain('role="feed"');
      expect(html).toContain("Bugün okumaya değer bir gönderi çıkmadı.");
      expect(html).toMatch(/Gösterilen<\/span><\/dt><dd>0<\/dd>/);
      expect(html).not.toContain('id="progress-now"');
    });

    it("error: plain reason, the kept posts, technical detail; no feed", () => {
      const html = render(docs.error);
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        "Claude 3 dakika içinde yanıt vermedi. Toplanan 120 gönderi duruyor",
      );
      expect(html).toContain("<summary>Teknik ayrıntı</summary>");
      expect(html).not.toContain('role="feed"');
      expect(html).not.toContain('id="done"');
      expect(html).toContain('<p class="topbar__meta">Hazırlanamadı</p>');
    });

    it("action buttons only for a host that handles them", () => {
      expect(render(docs.error)).not.toContain("data-action");
      const html = renderTimeline(docs.error, { actions: true });
      expect(html).toContain('data-action="retry"');
      expect(html).toContain('data-action="collect"');
    });
  });
});
