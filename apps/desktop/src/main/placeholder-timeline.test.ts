import { describe, expect, it } from "vitest";
import { toTimelineDoc, type Post, type TimelineDoc } from "@nmc/core";
import { escapeHtml, renderPlaceholderTimeline, TIMELINE_CSP } from "./placeholder-timeline.js";

// Fully synthetic, deliberately hostile content.
function post(id: string, extra: Partial<Post> = {}): Post {
  return {
    id,
    source: "x-home-timeline",
    authorHandle: "synthetic",
    text: `<script>alert(1)</script> "quoted" & more`,
    url: `https://x.com/synthetic/status/${id}`,
    publishedAt: "2026-01-01T09:00:00.000Z",
    media: [],
    promoted: false,
    ...extra,
  };
}

function doc(posts: Post[]): TimelineDoc {
  return toTimelineDoc(
    {
      selected: posts.map((p) => ({
        post: p,
        score: { postId: p.id, clickbaitScore: 0.1, readWorthinessScore: 0.7, checkWorthyClaim: null },
        verification: null,
      })),
      funnel: {
        scanned: 10,
        ads: 0,
        duplicates: 0,
        mediaOnly: 0,
        scoringFailed: 0,
        clickbait: 0,
        belowReadFloor: 0,
        contradicted: 0,
        rankedOut: 10 - posts.length,
        shown: posts.length,
      },
      settings: { timelineSize: 20 },
    },
    new Date("2026-01-01T10:00:00.000Z"),
  );
}

describe("renderPlaceholderTimeline", () => {
  it("escapes feed content and ships a script-free CSP", () => {
    const html = renderPlaceholderTimeline(doc([post("1", { authorName: '<img src=x onerror="x">' })]));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; more");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(TIMELINE_CSP);
    expect(TIMELINE_CSP).not.toMatch(/script-src/);
    expect(html).toContain('href="https://x.com/synthetic/status/1"');
  });

  it("drops non-https links", () => {
    const html = renderPlaceholderTimeline(doc([post("1", { url: "javascript:alert(1)" })]));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("X'te aç");
  });

  it("says when nothing was worth reading", () => {
    expect(renderPlaceholderTimeline(doc([]))).toContain("okumaya değer bir gönderi çıkmadı");
  });

  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href='x'>&"`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&quot;");
  });
});
