import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunMetricsCollector } from "../metrics.js";
import type { Scorer } from "../pipeline.js";
import {
  loadCapture,
  renderSelectedMarkdown,
  runCapture,
  scoreDistribution,
  type LoadedCapture,
} from "./capture-run.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** A fake scorer: read value from the post's position, one check-worthy post. */
const fakeScorer: Scorer = {
  score: async (posts) =>
    posts.map((post, index) => ({
      postId: post.id,
      clickbaitScore: index === 0 ? 0.9 : 0.1,
      readWorthinessScore: index === posts.length - 1 ? 0 : 0.9 - index * 0.1,
      checkWorthy: index === 1,
      checkWorthyClaim: index === 1 ? "a claim" : null,
      scoringFailed: false,
    })),
};

describe("capture run (synthetic capture directory)", () => {
  let dir: string;
  let capture: LoadedCapture;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-capture-run-"));
    await copyFile(
      join(fixtures, "x-home-timeline", "response-1.json"),
      join(dir, "0001-2026-01-01T00-00-00-000Z-HomeTimeline.json"),
    );
    await copyFile(
      join(fixtures, "x-home-timeline", "response-2.json"),
      join(dir, "0002-2026-01-01T00-00-10-000Z-HomeTimeline.json"),
    );
    await writeFile(join(dir, "notes.txt"), "not a capture", "utf8");
    await writeFile(
      join(dir, "summary.json"),
      JSON.stringify({
        firstCapturedAt: "2026-01-01T00:00:00.000Z",
        lastCapturedAt: "2026-01-01T00:00:10.000Z",
        postCount: 9,
        responseCount: 2,
        collectionSpanMs: 10_000,
      }),
      "utf8",
    );
    capture = await loadCapture(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads only the HomeTimeline dumps, in order, plus the collection summary", () => {
    expect(capture.files).toEqual([
      "0001-2026-01-01T00-00-00-000Z-HomeTimeline.json",
      "0002-2026-01-01T00-00-10-000Z-HomeTimeline.json",
    ]);
    expect(capture.parse.posts).toBe(capture.posts.length);
    expect(capture.collection).toMatchObject({ postCount: 9, responseCount: 2 });
  });

  it("limited to the first N dumps, rebuilds collection metrics from those dumps", async () => {
    const first = await loadCapture(dir, { maxResponses: 1 });
    expect(first.files).toEqual(["0001-2026-01-01T00-00-00-000Z-HomeTimeline.json"]);
    expect(first.collection).toMatchObject({
      firstCapturedAt: "2026-01-01T00:00:00.000Z",
      lastCapturedAt: "2026-01-01T00:00:00.000Z",
      responseCount: 1,
    });
    expect(first.collection?.postCount).toBeGreaterThan(0);
    expect(first.posts.length).toBeLessThan(capture.posts.length);
  });

  it("runs parse → hard filter → scorer → selector and reports every stage", async () => {
    const metrics = new RunMetricsCollector();
    const report = await runCapture(capture, {
      scorer: fakeScorer,
      metrics,
      selector: { maxClickbaitScore: 0.7, minReadWorthinessScore: 0.5 },
      timelineSize: 2,
    });
    const kept = report.hardFilter.kept;
    expect(report.hardFilter.seen).toBe(capture.posts.length);
    expect(report.scores).toHaveLength(kept);
    expect(report.metrics.postsIn).toBe(capture.posts.length);
    expect(report.metrics.postsAfterHardFilter).toBe(kept);
    expect(report.metrics.stageDurationsMs).toHaveProperty("parse");
    expect(report.metrics.collection?.postCount).toBe(9);
    // index 0 is clickbait, the last has no read value: both drop out.
    expect(report.selector.candidates).toBe(Math.min(kept - 2, 4));
    expect(report.selected.map((r) => r.score.postId)).toEqual(
      report.scores.slice(1, 3).map((s) => s.postId),
    );
    expect(report.selected.every((r) => r.verification === null)).toBe(true);
    expect(report.distribution.checkWorthy).toBe(1);

    const markdown = renderSelectedMarkdown(report);
    expect(markdown).toContain("# Seçilen 2 gönderi");
    expect(markdown).toContain(report.selected[0]?.post.url);
    expect(markdown).toContain("İddia: a claim");
  });
});

describe("scoreDistribution", () => {
  it("bins 0..1 scores onto 0-10 and keeps unscored posts out of the bins", () => {
    const d = scoreDistribution([
      { postId: "a", clickbaitScore: 0.3, readWorthinessScore: 0.7, checkWorthyClaim: null },
      {
        postId: "b",
        clickbaitScore: 0.3,
        readWorthinessScore: 1,
        checkWorthy: true,
        checkWorthyClaim: "c",
      },
      {
        postId: "c",
        clickbaitScore: 1,
        readWorthinessScore: 0,
        checkWorthyClaim: null,
        scoringFailed: true,
      },
    ]);
    expect(d.scored).toBe(2);
    expect(d.scoringFailed).toBe(1);
    expect(d.clickbait[3]).toBe(2);
    expect(d.readValue[7]).toBe(1);
    expect(d.readValue[10]).toBe(1);
    expect(d.checkWorthy).toBe(1);
  });
});
