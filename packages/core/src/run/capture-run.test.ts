import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunMetricsCollector } from "../metrics.js";
import type { Scorer } from "../pipeline.js";
import {
  loadCapture,
  renderClickbaitTopMarkdown,
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
      reason: index === 0 ? "merak tuzağı" : null,
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
    expect(first.warnings).toEqual([]);
  });

  it("warns instead of silently dropping collection metrics for unstamped dump names", async () => {
    const odd = await mkdtemp(join(tmpdir(), "nmc-capture-odd-"));
    try {
      for (const [n, name] of [
        [1, "a-HomeTimeline.json"],
        [2, "b-HomeTimeline.json"],
      ] as const) {
        await copyFile(
          join(fixtures, "x-home-timeline", `response-${n}.json`),
          join(odd, name),
        );
      }
      const limited = await loadCapture(odd, { maxResponses: 1 });
      expect(limited.collection).toBeUndefined();
      expect(limited.warnings).toHaveLength(1);
      expect(limited.warnings[0]).toMatch(/collection metrics omitted/);
    } finally {
      await rm(odd, { recursive: true, force: true });
    }
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
    const mediaOnly = report.hardFilter.flagged.mediaOnly;
    expect(mediaOnly).toBeGreaterThan(0);
    expect(report.hardFilter.seen).toBe(capture.posts.length);
    // Media-only posts skip the scorer and come back as unjudged.
    expect(report.scores).toHaveLength(kept - mediaOnly);
    expect(report.unjudged).toHaveLength(mediaOnly);
    expect(report.unjudged.every((p) => p.mediaOnly)).toBe(true);
    expect(report.metrics.postsIn).toBe(capture.posts.length);
    expect(report.metrics.postsAfterHardFilter).toBe(kept);
    expect(report.metrics.stageDurationsMs).toHaveProperty("parse");
    expect(report.metrics.collection?.postCount).toBe(9);
    // index 0 is clickbait, the last has no read value: both drop out.
    expect(report.selector.candidates).toBe(Math.min(kept - mediaOnly - 2, 4));
    expect(report.selected.map((r) => r.score.postId)).toEqual(
      report.scores.slice(1, 3).map((s) => s.postId),
    );
    expect(report.selected.every((r) => r.verification === null)).toBe(true);
    expect(report.distribution.checkWorthy).toBe(1);

    const markdown = renderSelectedMarkdown(report);
    expect(markdown).toContain("# Seçilen 2 gönderi");
    expect(markdown).toContain(report.selected[0]?.post.url);
    expect(markdown).toContain("İddia: a claim");
    expect(markdown).toContain(`# Yargılanamaz: ${mediaOnly} gönderi`);
    expect(markdown).toContain(report.unjudged[0]?.url);
    // Reasons ride along in result.json, null when none was given.
    expect(JSON.parse(JSON.stringify(report)).scores[1]).toHaveProperty("reason", null);

    const top = renderClickbaitTopMarkdown(report, capture.posts, 2);
    expect(top).toContain("# En yüksek clickbait: ilk 2 gönderi");
    const [first, second] = top.split("\n## ").slice(1);
    expect(first).toMatch(/^1\. @\S+ — clickbait 9\/10/);
    expect(first).toContain("Gerekçe: merak tuzağı");
    expect(second).toContain("Gerekçe: _gerekçe yok_");
    expect(top).not.toContain(report.unjudged[0]?.url);
  });

  it("clickbait-top leaves unscored placeholders out", async () => {
    const report = await runCapture(capture, {
      scorer: {
        score: async (posts) =>
          posts.map((post, index) => ({
            postId: post.id,
            clickbaitScore: index === 0 ? 1 : 0.2,
            readWorthinessScore: 0.5,
            checkWorthyClaim: null,
            scoringFailed: index === 0,
          })),
      },
      metrics: new RunMetricsCollector(),
      selector: { maxClickbaitScore: 0.7, minReadWorthinessScore: 0.2 },
      timelineSize: 50,
    });
    const top = renderClickbaitTopMarkdown(report, capture.posts);
    expect(top).toContain(`ilk ${report.scores.length - 1} gönderi`);
    expect(top).not.toContain("clickbait 10/10");
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
