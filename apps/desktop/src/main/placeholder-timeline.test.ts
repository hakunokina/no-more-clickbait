import { describe, expect, it } from "vitest";
import type { PipelineRunResult, Post } from "@nmc/core";
import { escapeHtml, renderPlaceholderTimeline, TIMELINE_CSP } from "./placeholder-timeline.js";
import { parsePipelineSettings, PIPELINE_DEFAULTS } from "./settings-file.js";

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

function result(posts: Post[]): PipelineRunResult {
  return {
    posts: posts.map((p) => ({
      post: p,
      score: { postId: p.id, clickbaitScore: 0.1, readWorthinessScore: 0.7, checkWorthyClaim: null },
      verification: null,
    })),
    unjudged: [],
    metrics: {
      stageDurationsMs: {},
      llmCalls: [],
      postsIn: 10,
      postsAfterHardFilter: posts.length,
      postsSelected: posts.length,
    },
  };
}

describe("renderPlaceholderTimeline", () => {
  it("escapes feed content and ships a script-free CSP", () => {
    const html = renderPlaceholderTimeline(
      result([post("1", { authorName: '<img src=x onerror="x">' })]),
      "2026-01-01T10:00:00.000Z",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; more");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(TIMELINE_CSP);
    expect(TIMELINE_CSP).not.toMatch(/script-src/);
    expect(html).toContain('href="https://x.com/synthetic/status/1"');
  });

  it("drops non-https links", () => {
    const html = renderPlaceholderTimeline(result([post("1", { url: "javascript:alert(1)" })]), null);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("X'te aç");
  });

  it("says when nothing was worth reading", () => {
    expect(renderPlaceholderTimeline(result([]), null)).toContain("okumaya değer bir gönderi çıkmadı");
  });

  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href='x'>&"`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&quot;");
  });
});

describe("parsePipelineSettings", () => {
  it("falls back to the owner's defaults", () => {
    expect(parsePipelineSettings(undefined)).toEqual(PIPELINE_DEFAULTS);
    expect(PIPELINE_DEFAULTS).toMatchObject({
      collectTarget: 250,
      timelineSize: 50,
      maxClickbait: 7,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
    });
  });

  it("takes valid fields and ignores invalid ones", () => {
    expect(
      parsePipelineSettings({ timelineSize: 30, maxClickbait: 99, verifyEnabled: false, minReadValue: 2.5 }),
    ).toMatchObject({ timelineSize: 30, maxClickbait: 7, verifyEnabled: false, minReadValue: 2 });
  });

  it("reads the legacy modeBTarget when collectTarget is absent", () => {
    expect(parsePipelineSettings({ modeBTarget: 80 }).collectTarget).toBe(80);
    expect(parsePipelineSettings({ modeBTarget: 80, collectTarget: 300 }).collectTarget).toBe(300);
  });
});
