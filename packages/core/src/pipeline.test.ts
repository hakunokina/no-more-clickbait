import { describe, expect, it } from "vitest";
import {
  createThresholdSelector,
  mapWithConcurrency,
  runPipeline,
  type Pipeline,
} from "./pipeline.js";
import type { Post, ScoreEntry, VerificationResult, VerificationStatus } from "./schemas.js";

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

function verification(
  postId: string,
  claim: string,
  status: VerificationStatus,
): VerificationResult {
  return {
    postId,
    claim,
    status,
    confidence: 0.8,
    summary: "fake",
    sources:
      status === "verified" || status === "false_or_disputed"
        ? [{ url: "https://example.invalid/source", title: "source" }]
        : [],
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
        verify: async (p, claim) =>
          verification(
            p.id,
            claim,
            contradictedIds.has(p.id) ? "false_or_disputed" : "verified",
          ),
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

  it("takes the ranked top N unverified when no verifier is configured", async () => {
    const { verifier: _verifier, ...pipeline } = fakePipeline(new Set(["a"]));
    const out = await runPipeline(pipeline, posts, { timelineSize: 2, verifyConcurrency: 1 });
    expect(out.posts.map((r) => [r.post.id, r.verification])).toEqual([
      ["a", null],
      ["b", null],
    ]);
    expect(out.metrics.postsSelected).toBe(2);
    expect(out.metrics.stageDurationsMs).not.toHaveProperty("verifier");
  });

  it("selector ranks by read-worthiness, lower clickbait breaking ties", () => {
    const selector = createThresholdSelector({
      maxClickbaitScore: 0.7,
      minReadWorthinessScore: 0.5,
    });
    const ranked = selector.select([
      {
        post: post("low"),
        score: score("low", { readWorthinessScore: 0.6, clickbaitScore: 0 }),
      },
      {
        post: post("tie-cb"),
        score: score("tie-cb", { readWorthinessScore: 0.8, clickbaitScore: 0.5 }),
      },
      {
        post: post("best"),
        score: score("best", { readWorthinessScore: 0.8, clickbaitScore: 0.1 }),
      },
    ]);
    expect(ranked.map((r) => r.post.id)).toEqual(["best", "tie-cb", "low"]);
  });

  it("passes media-only posts through unscored, outside the ranking and timelineSize", async () => {
    const seen: string[] = [];
    const { verifier: _verifier, ...pipeline } = fakePipeline(new Set());
    pipeline.scorer = {
      score: async (input) => {
        seen.push(...input.map((p) => p.id));
        return input.map((p) => score(p.id));
      },
    };
    const input = [
      post("m1", { text: "", mediaOnly: true }),
      post("a"),
      post("m2", { text: "", mediaOnly: true }),
      post("b"),
    ];
    const out = await runPipeline(pipeline, input, { timelineSize: 1, verifyConcurrency: 1 });
    expect(seen).toEqual(["a", "b"]);
    expect(out.posts.map((r) => r.post.id)).toEqual(["a"]);
    expect(out.unjudged.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(out.metrics.postsSelected).toBe(1);
  });

  it("skips the scorer when only media-only posts survive the hard filter", async () => {
    const pipeline = fakePipeline(new Set());
    pipeline.scorer = {
      score: async () => {
        throw new Error("scorer must not be called");
      },
    };
    const out = await runPipeline(pipeline, [post("m", { text: "", mediaOnly: true })], {
      timelineSize: 5,
      verifyConcurrency: 1,
    });
    expect(out.posts).toEqual([]);
    expect(out.unjudged.map((p) => p.id)).toEqual(["m"]);
  });

  it("ends the timeline short when the read floor leaves fewer than N (no padding)", async () => {
    const { verifier: _verifier, ...pipeline } = fakePipeline(new Set());
    pipeline.selector = createThresholdSelector({
      maxClickbaitScore: 0.7,
      minReadWorthinessScore: 0.2,
    });
    pipeline.scorer = {
      score: async (input) =>
        input.map((p) =>
          score(p.id, { readWorthinessScore: p.id === "a" ? 0.3 : p.id === "b" ? 0.2 : 0.1 }),
        ),
    };
    const out = await runPipeline(pipeline, posts, { timelineSize: 50, verifyConcurrency: 1 });
    expect(out.posts.map((r) => r.post.id)).toEqual(["a", "b"]);
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

describe("runPipeline verification (fake Verifier)", () => {
  /** Posts p0..p{n-1}, ranked in that order; `worthy` ids carry a claim. */
  function ranked(n: number, worthy: (id: string) => boolean = () => true) {
    const input = Array.from({ length: n }, (_, i) => post(`p${i}`));
    const scorer = {
      score: async (posts: readonly Post[]) =>
        posts.map((p, i) =>
          score(p.id, {
            readWorthinessScore: 0.99 - i * 0.01,
            checkWorthy: worthy(p.id),
            checkWorthyClaim: worthy(p.id) ? `claim of ${p.id}` : null,
          }),
        ),
    };
    return { input, scorer };
  }

  function pipelineWith(
    scorer: Pipeline["scorer"],
    statusOf: (id: string) => VerificationStatus,
    onVerify: (id: string) => void = () => {},
  ): Pipeline {
    return {
      hardFilter: { keep: () => true },
      scorer,
      selector: createThresholdSelector({ maxClickbaitScore: 0.7, minReadWorthinessScore: 0 }),
      verifier: {
        verify: async (p, claim) => {
          onVerify(p.id);
          await new Promise((r) => setTimeout(r, 2));
          return verification(p.id, claim, statusOf(p.id));
        },
      },
    };
  }

  it("verifies only check-worthy posts with a claim", async () => {
    const { input, scorer } = ranked(4, (id) => id === "p1" || id === "p3");
    const seen: string[] = [];
    const out = await runPipeline(
      pipelineWith(
        scorer,
        () => "verified",
        (id) => seen.push(id),
      ),
      input,
      { timelineSize: 4, verifyConcurrency: 4 },
    );
    expect(seen.sort()).toEqual(["p1", "p3"]);
    expect(out.posts.map((r) => [r.post.id, r.verification?.status ?? null])).toEqual([
      ["p0", null],
      ["p1", "verified"],
      ["p2", null],
      ["p3", "verified"],
    ]);
    expect(out.verification).toMatchObject({ calls: 2, rejected: 0, backfilled: 0 });
  });

  it("chains backfills: a rejected backfill is itself verified and replaced", async () => {
    const { input, scorer } = ranked(6);
    const rejected = new Set(["p1", "p3", "p4"]);
    const out = await runPipeline(
      pipelineWith(scorer, (id) => (rejected.has(id) ? "false_or_disputed" : "unverifiable")),
      input,
      { timelineSize: 3, verifyConcurrency: 2 },
    );
    // p1 out → p3 (rejected) → p4 (rejected) → p5.
    expect(out.posts.map((r) => r.post.id)).toEqual(["p0", "p2", "p5"]);
    // unverifiable stays in the selection with its status.
    expect(out.posts.every((r) => r.verification?.status === "unverifiable")).toBe(true);
    expect(out.verification).toMatchObject({
      calls: 6,
      rejected: 3,
      backfilled: 1,
      byStatus: { verified: 0, false_or_disputed: 3, unverifiable: 3 },
    });
    expect(out.verification?.results.map((r) => r.postId)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    expect(out.metrics.postsSelected).toBe(3);
  });

  it("ends short when rejections exhaust the candidates", async () => {
    const { input, scorer } = ranked(3);
    const out = await runPipeline(
      pipelineWith(scorer, (id) => (id === "p0" ? "verified" : "false_or_disputed")),
      input,
      { timelineSize: 3, verifyConcurrency: 3 },
    );
    expect(out.posts.map((r) => r.post.id)).toEqual(["p0"]);
    expect(out.verification?.rejected).toBe(2);
  });

  it("caps verification calls per run, higher read value first", async () => {
    const { input, scorer } = ranked(30);
    const seen: string[] = [];
    const out = await runPipeline(
      pipelineWith(
        scorer,
        () => "verified",
        (id) => seen.push(id),
      ),
      input,
      { timelineSize: 30, verifyConcurrency: 4 },
    );
    expect(seen).toHaveLength(20);
    expect(new Set(seen)).toEqual(new Set(input.slice(0, 20).map((p) => p.id)));
    expect(out.posts).toHaveLength(30);
    expect(out.posts.slice(20).every((r) => r.verification === null)).toBe(true);
    expect(out.verification).toMatchObject({ calls: 20, skippedOverBudget: 10 });
  });

  it("spends the budget on backfills too, and stops verifying when it runs out", async () => {
    const { input, scorer } = ranked(6);
    const out = await runPipeline(
      pipelineWith(scorer, (id) => (id === "p0" ? "false_or_disputed" : "verified")),
      input,
      { timelineSize: 3, verifyConcurrency: 1, maxVerifications: 3 },
    );
    // p0..p2 use the budget; p0 is rejected, its backfill p3 stays unverified.
    expect(out.posts.map((r) => [r.post.id, r.verification?.status ?? null])).toEqual([
      ["p1", "verified"],
      ["p2", "verified"],
      ["p3", null],
    ]);
    expect(out.verification).toMatchObject({ calls: 3, skippedOverBudget: 1, backfilled: 1 });
  });

  it("never runs more verifications at once than the concurrency limit", async () => {
    const { input, scorer } = ranked(12);
    let inFlight = 0;
    let maxInFlight = 0;
    const pipeline = pipelineWith(scorer, () => "verified");
    pipeline.verifier = {
      verify: async (p, claim) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return verification(p.id, claim, "verified");
      },
    };
    await runPipeline(pipeline, input, { timelineSize: 12, verifyConcurrency: 4 });
    expect(maxInFlight).toBe(4);
  });

  it("verifies only posts with read value ≥ 5/10; the rest stay in unverified", async () => {
    const reads = [0.9, 0.5, 0.49, 0.3];
    const input = reads.map((_, i) => post(`r${i}`));
    const scorer: Pipeline["scorer"] = {
      score: async (posts) =>
        posts.map((p, i) =>
          score(p.id, {
            readWorthinessScore: reads[i] ?? 0,
            checkWorthy: true,
            checkWorthyClaim: `claim of ${p.id}`,
          }),
        ),
    };
    const seen: string[] = [];
    const out = await runPipeline(
      pipelineWith(
        scorer,
        () => "verified",
        (id) => seen.push(id),
      ),
      input,
      { timelineSize: 4, verifyConcurrency: 2 },
    );
    expect(seen.sort()).toEqual(["r0", "r1"]);
    expect(out.posts.map((r) => [r.post.id, r.verification?.status ?? null])).toEqual([
      ["r0", "verified"],
      ["r1", "verified"],
      ["r2", null],
      ["r3", null],
    ]);
    expect(out.verification).toMatchObject({ calls: 2, skippedBelowRead: 2 });

    const lowered = await runPipeline(
      pipelineWith(scorer, () => "verified"),
      input,
      {
        timelineSize: 4,
        verifyConcurrency: 2,
        minReadForVerify: 0.3,
      },
    );
    expect(lowered.verification).toMatchObject({ calls: 4, skippedBelowRead: 0 });
  });

  it("holds a backfilled post to the same read floor", async () => {
    const reads = [0.9, 0.8, 0.4];
    const input = reads.map((_, i) => post(`b${i}`));
    const scorer: Pipeline["scorer"] = {
      score: async (posts) =>
        posts.map((p, i) =>
          score(p.id, {
            readWorthinessScore: reads[i] ?? 0,
            checkWorthy: true,
            checkWorthyClaim: `claim of ${p.id}`,
          }),
        ),
    };
    const out = await runPipeline(
      pipelineWith(scorer, (id) => (id === "b0" ? "false_or_disputed" : "verified")),
      input,
      { timelineSize: 2, verifyConcurrency: 2, minReadForVerify: 0.5 },
    );
    expect(out.posts.map((r) => [r.post.id, r.verification?.status ?? null])).toEqual([
      ["b1", "verified"],
      ["b2", null],
    ]);
    expect(out.verification).toMatchObject({ rejected: 1, backfilled: 1, skippedBelowRead: 1 });
  });

  it("counts failed verifications, which stay in as unverifiable", async () => {
    const { input, scorer } = ranked(2);
    const pipeline = pipelineWith(scorer, () => "verified");
    pipeline.verifier = {
      verify: async (p, claim) => ({
        ...verification(p.id, claim, "unverifiable"),
        failed: true,
      }),
    };
    const out = await runPipeline(pipeline, input, { timelineSize: 2, verifyConcurrency: 2 });
    expect(out.posts).toHaveLength(2);
    expect(out.verification).toMatchObject({ failed: 2, byStatus: { unverifiable: 2 } });
  });
});
