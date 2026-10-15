import { describe, expect, it } from "vitest";
import {
  createThresholdSelector,
  mapWithConcurrency,
  runPipeline,
  type Pipeline,
} from "./pipeline.js";
import type { Post, ScoreEntry } from "./schemas.js";

function post(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    source: "synthetic",
    authorHandle: `user_${id}`,
    text: `text of ${id}`,
    url: `https://example.invalid/posts/${id}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    media: [],
    promoted: false,
    ...overrides,
  };
}

function score(postId: string, overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return {
    postId,
    clickbaitScore: 0.1,
    readWorthinessScore: 0.9,
    checkWorthyClaim: null,
    ...overrides,
  };
}

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight).toBe(2);
  });
});

describe("runPipeline (fake Scorer/Verifier)", () => {
  const posts = [post("a"), post("b"), post("c"), post("ad", { promoted: true })];

  function fakePipeline(contradictedIds: ReadonlySet<string>): Pipeline {
    return {
      hardFilter: { keep: (p) => !p.promoted },
      scorer: {
        score: async (input) =>
          input.map((p) =>
            score(p.id, {
              readWorthinessScore: p.id === "a" ? 0.95 : p.id === "b" ? 0.9 : 0.85,
              checkWorthyClaim: `claim of ${p.id}`,
            }),
          ),
      },
      selector: createThresholdSelector({
        maxClickbaitScore: 0.7,
        minReadWorthinessScore: 0.5,
      }),
      verifier: {
        verify: async (p, claim) => ({
          postId: p.id,
          claim,
          verdict: contradictedIds.has(p.id) ? "contradicted" : "supported",
          rationale: "fake",
          sources: [],
        }),
      },
    };
  }

  it("drops promoted posts in the hard filter before scoring", async () => {
    const out = await runPipeline(fakePipeline(new Set()), posts, {
      timelineSize: 10,
      verifyConcurrency: 2,
    });
    expect(out.posts.map((r) => r.post.id)).toEqual(["a", "b", "c"]);
    expect(out.metrics.postsIn).toBe(4);
    expect(out.metrics.postsAfterHardFilter).toBe(3);
    expect(out.metrics.postsSelected).toBe(3);
    expect(out.metrics.stageDurationsMs).toHaveProperty("scorer");
  });

  it("backfills from further down the list when verification contradicts a pick", async () => {
    const out = await runPipeline(fakePipeline(new Set(["a"])), posts, {
      timelineSize: 2,
      verifyConcurrency: 2,
    });
    expect(out.posts.map((r) => r.post.id)).toEqual(["b", "c"]);
  });

  it("keeps posts without a claim unverified (verification: null)", async () => {
    const pipeline = fakePipeline(new Set());
    pipeline.scorer = { score: async (input) => input.map((p) => score(p.id)) };
    const out = await runPipeline(pipeline, [post("x")], {
      timelineSize: 1,
      verifyConcurrency: 1,
    });
    expect(out.posts[0]?.verification).toBeNull();
  });

  it("selector drops clickbait above the threshold", async () => {
    const pipeline = fakePipeline(new Set());
    pipeline.scorer = {
      score: async (input) =>
        input.map((p) => score(p.id, { clickbaitScore: p.id === "a" ? 0.99 : 0.1 })),
    };
    const out = await runPipeline(pipeline, posts, { timelineSize: 10, verifyConcurrency: 1 });
    expect(out.posts.map((r) => r.post.id)).not.toContain("a");
  });
});
