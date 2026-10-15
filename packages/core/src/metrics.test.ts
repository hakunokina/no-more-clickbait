import { describe, expect, it } from "vitest";
import {
  countTimelineEntries,
  RunMetricsCollector,
  RunMetricsSchema,
  summarizeRunMetrics,
} from "./metrics.js";

describe("RunMetrics", () => {
  it("summarises tokens, cache, cost and the collection span", () => {
    const collector = new RunMetricsCollector();
    collector.collection = {
      firstCapturedAt: "2026-01-01T00:00:00.000Z",
      lastCapturedAt: "2026-01-01T00:02:30.000Z",
      postCount: 250,
    };
    collector.recordLlmCall({
      providerId: "claude-cli",
      stage: "scorer",
      startedAt: "2026-01-01T00:03:00.000Z",
      durationMs: 4000,
      inputTokens: 9000,
      outputTokens: 1200,
      cacheReadTokens: 3000,
      cacheCreationTokens: 500,
      costUsd: 0.04,
    });
    collector.recordLlmCall({
      providerId: "claude-cli",
      stage: "verifier",
      startedAt: "2026-01-01T00:03:05.000Z",
      durationMs: 2000,
      inputTokens: 800,
      outputTokens: 200,
      costUsd: 0.01,
    });

    const metrics = RunMetricsSchema.parse(collector.toRunMetrics());
    const totals = summarizeRunMetrics(metrics);
    expect(totals).toMatchObject({
      llmCallCount: 2,
      totalDurationMs: 6000,
      inputTokens: 9800,
      outputTokens: 1400,
      cacheReadTokens: 3000,
      cacheCreationTokens: 500,
      collectionSpanMs: 150_000,
    });
    expect(totals.costUsd).toBeCloseTo(0.05);
  });

  it("leaves cost undefined when no provider reported one", () => {
    const collector = new RunMetricsCollector();
    collector.recordLlmCall({
      providerId: "fake",
      stage: "scorer",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
    });
    expect(summarizeRunMetrics(collector.toRunMetrics()).costUsd).toBeUndefined();
  });
});

describe("countTimelineEntries", () => {
  // Synthetic shape only — modelled on the entryId convention, no real data.
  const synthetic = {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              entries: [
                {
                  entryId: "tweet-1",
                  content: { itemContent: { __typename: "TimelineTweet" } },
                },
                { entryId: "promoted-tweet-2", content: {} },
                {
                  entryId: "tweet-3",
                  content: { items: [{ entryId: "conversationthread-9" }] },
                },
                { entryId: "cursor-bottom-0", content: {} },
              ],
            },
          ],
        },
      },
    },
  };

  it("counts tweet- entries, tracks promoted apart, ignores the rest", () => {
    expect(countTimelineEntries(synthetic)).toEqual({ postCount: 2, promotedCount: 1 });
  });

  it("returns zeros for non-object payloads", () => {
    expect(countTimelineEntries(null)).toEqual({ postCount: 0, promotedCount: 0 });
    expect(countTimelineEntries("tweet-1 in plain text")).toEqual({
      postCount: 0,
      promotedCount: 0,
    });
  });
});
