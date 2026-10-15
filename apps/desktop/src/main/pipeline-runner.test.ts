import { describe, expect, it } from "vitest";
import {
  feedItemKey,
  SettingsSchema,
  type FeedItem,
  type Post,
  type ScoreEntry,
  type Settings,
  type VerificationResult,
} from "@nmc/core";
import { CliNotAuthenticatedError, CliRunError, type LlmAvailability } from "@nmc/core/llm";
import {
  PipelineRunner,
  RunBusyError,
  type RunProgress,
  type RunStages,
} from "./pipeline-runner.js";

// Fully synthetic posts — no real feed data.
function post(id: string, extra: Partial<Post> = {}): Post {
  return {
    id,
    source: "x-home-timeline",
    authorHandle: "synthetic",
    text: `synthetic post ${id}`,
    url: `https://x.com/synthetic/status/${id}`,
    publishedAt: "2026-01-01T09:00:00.000Z",
    media: [],
    promoted: false,
    ...extra,
  };
}

function score(
  postId: string,
  read: number,
  clickbait = 0.1,
  claim: string | null = null,
): ScoreEntry {
  return {
    postId,
    clickbaitScore: clickbait,
    readWorthinessScore: read,
    checkWorthy: claim !== null,
    checkWorthyClaim: claim,
    reason: "synthetic",
  };
}

function verification(
  postId: string,
  claim: string,
  status: VerificationResult["status"],
): VerificationResult {
  return {
    postId,
    claim,
    status,
    confidence: 0.8,
    summary: "synthetic",
    sources:
      status === "unverifiable" ? [] : [{ url: "https://example.invalid/a", title: "A" }],
  };
}

interface FakeOptions {
  availability?: LlmAvailability;
  scores?: (posts: readonly FeedItem[]) => ScoreEntry[];
  scoreError?: unknown;
  verify?: (post: Post, claim: string) => Promise<VerificationResult>;
  hangScorer?: boolean;
}

function fakeStages(options: FakeOptions = {}): { stages: RunStages; killed: () => boolean } {
  let killed = false;
  let releaseHang: () => void = () => {};
  const stages: RunStages = {
    checkAvailable: async () => options.availability ?? { ok: true, version: "fake 1.0" },
    scorer: {
      async score(posts) {
        if (options.hangScorer) {
          await new Promise<void>((resolve) => (releaseHang = resolve));
          throw new CliRunError("claude", "killed");
        }
        if (options.scoreError) throw options.scoreError;
        return options.scores ? options.scores(posts) : posts.map((p) => score(p.id, 0.5));
      },
    },
    verifier: {
      verify: options.verify ?? (async (p, claim) => verification(p.id, claim, "verified")),
    },
    cancel() {
      killed = true;
      releaseHang();
    },
  };
  return { stages, killed: () => killed };
}

const settings = (overrides: Partial<Settings> = {}): Settings =>
  SettingsSchema.parse({ timelineSize: 50, ...overrides });

describe("PipelineRunner", () => {
  it("runs filter → scorer → selector → verifier and reports progress", async () => {
    const posts = [
      post("1"),
      post("1"), // repeat: dropped by the hard filter
      post("2", { promoted: true }), // ad: dropped
      post("3", { text: "", mediaOnly: true }), // unjudged
      post("4"),
      post("5"),
    ];
    const { stages } = fakeStages({
      scores: () => [score("1", 0.9, 0.1, "claim one"), score("4", 0.6), score("5", 0.4, 0.9)],
      verify: async (p, claim) =>
        verification(p.id, claim, p.id === "1" ? "verified" : "unverifiable"),
    });
    const progress: RunProgress[] = [];
    const runner = new PipelineRunner(() => stages);
    const outcome = await runner.run(posts, settings({ timelineSize: 10 }), (p) =>
      progress.push(p),
    );

    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.result.posts.map((r) => r.post.id)).toEqual(["1", "4"]);
    expect(outcome.result.posts[0]?.verification?.status).toBe("verified");
    expect(outcome.counts).toMatchObject({
      postsIn: 6,
      afterHardFilter: 4,
      mediaOnly: 1,
      selected: 2,
      filteredOut: 1,
      verifyDone: 1,
      verifyTotal: 1,
    });
    expect(progress.map((p) => p.stage)).toEqual([
      "checking",
      "filtering",
      "scoring",
      "verifying",
      "verifying",
      "verifying",
    ]);
    expect(runner.busy).toBe(false);
  });

  it("counts the claims to verify for non-X items by their feed key", async () => {
    const item: FeedItem = {
      platform: "generic",
      id: "t3_synth",
      sourceLabel: "reddit",
      title: "synthetic title",
      url: "https://www.reddit.com/r/synthetic/comments/t3_synth/",
      domain: "reddit.com",
      promoted: false,
    };
    const key = feedItemKey(item);
    const { stages } = fakeStages({
      scores: () => [score(key, 0.9, 0.1, "claim")],
      verify: async (_p, claim) => verification(key, claim, "verified"),
    });
    const progress: RunProgress[] = [];
    const runner = new PipelineRunner(() => stages);
    const outcome = await runner.run([item], settings({ timelineSize: 10 }), (p) =>
      progress.push(p),
    );

    expect(outcome.status).toBe("done");
    // Announced right after scoring (not only once the first check starts).
    expect(progress.map((p) => p.stage)).toEqual([
      "checking",
      "filtering",
      "scoring",
      "verifying",
      "verifying",
      "verifying",
    ]);
    expect(progress[3]?.counts).toMatchObject({ verifyTotal: 1, verifyDone: 0 });
  });

  it("skips the verifier when verification is off", async () => {
    let calls = 0;
    const { stages } = fakeStages({
      scores: (posts) => posts.map((p) => score(p.id, 0.8, 0.1, "claim")),
      verify: async (p, claim) => {
        calls += 1;
        return verification(p.id, claim, "verified");
      },
    });
    const outcome = await new PipelineRunner(() => stages).run(
      [post("1"), post("2")],
      settings({ verifyEnabled: false }),
      () => {},
    );
    expect(outcome.status).toBe("done");
    expect(calls).toBe(0);
  });

  it("allows one run at a time", async () => {
    const { stages } = fakeStages({ hangScorer: true });
    const runner = new PipelineRunner(() => stages);
    const first = runner.run([post("1")], settings(), () => {});
    await expect(runner.run([post("2")], settings(), () => {})).rejects.toBeInstanceOf(
      RunBusyError,
    );
    expect(runner.cancel()).toBe(true);
    await expect(first).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels at once and kills the CLI children", async () => {
    const fake = fakeStages({ hangScorer: true });
    const runner = new PipelineRunner(() => fake.stages);
    const stages: string[] = [];
    const running = runner.run([post("1")], settings(), (p) => stages.push(p.stage));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stages.at(-1)).toBe("scoring");
    expect(runner.cancel()).toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(fake.killed()).toBe(true);
    expect(runner.busy).toBe(false);
    expect(runner.cancel()).toBe(false);
  });

  it("stops in-flight verification on cancel", async () => {
    let started = 0;
    const runner = new PipelineRunner(
      () =>
        fakeStages({
          scores: (posts) => posts.map((p) => score(p.id, 0.9, 0.1, `claim ${p.id}`)),
          verify: () => {
            started += 1;
            return new Promise<VerificationResult>(() => {});
          },
        }).stages,
    );
    const running = runner.run([post("1"), post("2"), post("3")], settings(), () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBeGreaterThan(0);
    runner.cancel();
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
  });

  it("turns a missing or logged-out CLI into a clear error before any work", async () => {
    let scored = false;
    const notFound = fakeStages({
      availability: { ok: false, reason: "not-found", detail: "spawn claude ENOENT" },
      scores: () => {
        scored = true;
        return [];
      },
    });
    const outcome = await new PipelineRunner(() => notFound.stages).run(
      [post("1")],
      settings(),
      () => {},
    );
    expect(outcome).toMatchObject({ status: "error", error: { kind: "cli-not-found" } });
    expect(scored).toBe(false);

    const loggedOut = fakeStages({
      availability: { ok: false, reason: "not-authenticated", detail: '{"loggedIn": false}' },
    });
    await expect(
      new PipelineRunner(() => loggedOut.stages).run([post("1")], settings(), () => {}),
    ).resolves.toMatchObject({ status: "error", error: { kind: "cli-not-authenticated" } });
  });

  it("classifies CLI failures during the run", async () => {
    const auth = fakeStages({ scoreError: new CliNotAuthenticatedError("claude", "401") });
    await expect(
      new PipelineRunner(() => auth.stages).run([post("1")], settings(), () => {}),
    ).resolves.toMatchObject({ status: "error", error: { kind: "cli-not-authenticated" } });

    const failed = fakeStages({ scoreError: new CliRunError("claude", "timed out") });
    await expect(
      new PipelineRunner(() => failed.stages).run([post("1")], settings(), () => {}),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "cli-error", detail: 'LLM CLI "claude" failed: timed out' },
    });

    const odd = fakeStages({ scoreError: new Error("boom") });
    await expect(
      new PipelineRunner(() => odd.stages).run([post("1")], settings(), () => {}),
    ).resolves.toMatchObject({ status: "error", error: { kind: "internal" } });
  });
});
