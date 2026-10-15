import { z } from "zod";

/**
 * Per-run measurements. The desktop "token monitor" window renders
 * these; the first real end-to-end test targets a 250-post batch, so
 * collection span and per-call LLM cost must be visible from day one.
 */

/** How long passive collection took and how much it gathered. */
export const CollectionMetricsSchema = z.object({
  /** ISO 8601 time of the first HomeTimeline capture in the run. */
  firstCapturedAt: z.string().datetime(),
  /** ISO 8601 time of the last HomeTimeline capture in the run. */
  lastCapturedAt: z.string().datetime(),
  /**
   * Posts captured across all timeline responses in the run. In a
   * developer-capture summary this is the ROUGH count (`tweet-` entries
   * per response, repeats across responses included).
   */
  postCount: z.number().int().nonnegative(),
  /** Distinct organic posts (parsed, no ads, no cross-response repeats). */
  uniquePostCount: z.number().int().nonnegative().optional(),
  /** Timeline responses captured (developer capture). */
  responseCount: z.number().int().nonnegative().optional(),
  /** Rough promoted-entry count, tracked apart from posts. */
  promotedCount: z.number().int().nonnegative().optional(),
  /** Responses refused because they exceeded the bridge frame ceiling. */
  oversizedCount: z.number().int().nonnegative().optional(),
});
export type CollectionMetrics = z.infer<typeof CollectionMetricsSchema>;

export interface TimelineEntryCounts {
  postCount: number;
  promotedCount: number;
}

/**
 * Rough post count over a parsed X timeline payload — deliberately NOT
 * a parser: it only tallies timeline entries by their `entryId` prefix
 * ("tweet-…" vs "promoted-…"), which is durable across response-shape
 * changes. Duplicates across overlapping responses are counted as seen.
 */
export function countTimelineEntries(payload: unknown): TimelineEntryCounts {
  let postCount = 0;
  let promotedCount = 0;
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      const entryId = record["entryId"];
      if (typeof entryId === "string") {
        if (entryId.startsWith("promoted")) promotedCount += 1;
        else if (entryId.startsWith("tweet-")) postCount += 1;
      }
      for (const value of Object.values(record)) stack.push(value);
    }
  }
  return { postCount, promotedCount };
}

/** One LLM call's cost/latency, from the provider's own usage report. */
export const LlmCallMetricsSchema = z.object({
  providerId: z.string().min(1),
  /** Which pipeline stage made the call, e.g. "scorer" | "verifier". */
  stage: z.string().min(1),
  /** ISO 8601 start time of the call. */
  startedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  /** Thinking tokens, already included in outputTokens. */
  thinkingTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
  /** Provider-reported cost in USD, when the provider reports one. */
  costUsd: z.number().nonnegative().optional(),
  /** Model that served the call, as the provider reports it. */
  model: z.string().min(1).optional(),
  /** Why generation stopped, e.g. "end_turn" or "max_tokens" (truncated). */
  stopReason: z.string().min(1).optional(),
  /** Web searches the call ran, when the provider reports them. */
  webSearchRequests: z.number().int().nonnegative().optional(),
  /** Post the call was about (per-claim stages such as the Verifier). */
  postId: z.string().min(1).optional(),
  /** Posts the call carried (per-post token cost = tokens / postCount). */
  postCount: z.number().int().nonnegative().optional(),
  /**
   * True when the call yielded no usable result: timing only when the
   * call itself failed, tokens too when it ran but its reply was unusable.
   */
  failed: z.boolean().optional(),
});
export type LlmCallMetrics = z.infer<typeof LlmCallMetricsSchema>;

/**
 * Where every scanned post went, each in exactly one bucket, so the
 * "Done" tally adds up: scanned = the sum of every other field. The
 * first matching rule wins, in field order (e.g. a post that is both
 * clickbait and below the read floor counts as clickbait).
 */
export const FunnelCountsSchema = z
  .object({
    /** Posts entering the pipeline (parsed, ads and repeats included). */
    scanned: z.number().int().nonnegative(),
    /** Ads (platform-marked promoted posts). */
    ads: z.number().int().nonnegative(),
    /** Repeats of a post already seen in the run (overlap, reposts). */
    duplicates: z.number().int().nonnegative(),
    /** Media-only posts: no text to judge, never scored or shown. */
    mediaOnly: z.number().int().nonnegative(),
    /** The Scorer returned no usable score for these. */
    scoringFailed: z.number().int().nonnegative(),
    /** Clickbait score at or above the limit. */
    clickbait: z.number().int().nonnegative(),
    /** Read value below the floor. */
    belowReadFloor: z.number().int().nonnegative(),
    /** Verification found sources contradicting the post's claim. */
    contradicted: z.number().int().nonnegative(),
    /** Passed every rule but ranked below the first N (timeline full). */
    rankedOut: z.number().int().nonnegative(),
    /** In the final timeline. */
    shown: z.number().int().nonnegative(),
  })
  .refine(
    (f) =>
      f.scanned ===
      f.ads +
        f.duplicates +
        f.mediaOnly +
        f.scoringFailed +
        f.clickbait +
        f.belowReadFloor +
        f.contradicted +
        f.rankedOut +
        f.shown,
    "funnel buckets must add up to scanned",
  );
export type FunnelCounts = z.infer<typeof FunnelCountsSchema>;

/**
 * One source's share of a run: how many of its posts were scanned and
 * how many made the timeline. `label` is `feedSourceLabel` of the posts.
 */
export const SourceCountSchema = z
  .object({
    label: z.string().min(1),
    /** Posts of this source entering the pipeline (`FunnelCounts.scanned` share). */
    in: z.number().int().nonnegative(),
    /** Of those, in the final timeline (`FunnelCounts.shown` share). */
    shown: z.number().int().nonnegative(),
  })
  .refine((count) => count.shown <= count.in, "shown cannot exceed in");
export type SourceCount = z.infer<typeof SourceCountSchema>;

export const RunMetricsSchema = z.object({
  collection: CollectionMetricsSchema.optional(),
  /** Pipeline stage timings in milliseconds, keyed by stage name. */
  stageDurationsMs: z.record(z.string(), z.number().nonnegative()),
  llmCalls: z.array(LlmCallMetricsSchema),
  /** Posts entering the pipeline. */
  postsIn: z.number().int().nonnegative(),
  /** Posts surviving the hard filter. */
  postsAfterHardFilter: z.number().int().nonnegative(),
  /** Posts in the final verified selection (the JSON output). */
  postsSelected: z.number().int().nonnegative(),
  /** Per-bucket fate of every scanned post (absent in older runs). */
  funnel: FunnelCountsSchema.optional(),
  /**
   * Scanned/shown per source, in order of first appearance in the input
   * (absent in older runs). A source that delivered nothing is not
   * listed: its absence is a collection failure, not a zero.
   */
  bySource: z.array(SourceCountSchema).optional(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export interface RunMetricsTotals {
  llmCallCount: number;
  /** Calls recorded as failed (included in llmCallCount). */
  failedCallCount: number;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Web searches the calls reported running. */
  webSearchRequests: number;
  /** Sum of reported costs; undefined when no call reported a cost. */
  costUsd: number | undefined;
  /** Last minus first capture time; undefined without collection data. */
  collectionSpanMs: number | undefined;
}

export function summarizeRunMetrics(metrics: RunMetrics): RunMetricsTotals {
  const sum = (pick: (call: LlmCallMetrics) => number | undefined): number =>
    metrics.llmCalls.reduce((total, call) => total + (pick(call) ?? 0), 0);
  const anyCost = metrics.llmCalls.some((call) => call.costUsd !== undefined);
  const collection = metrics.collection;
  return {
    llmCallCount: metrics.llmCalls.length,
    failedCallCount: metrics.llmCalls.filter((call) => call.failed === true).length,
    totalDurationMs: sum((call) => call.durationMs),
    inputTokens: sum((call) => call.inputTokens),
    outputTokens: sum((call) => call.outputTokens),
    thinkingTokens: sum((call) => call.thinkingTokens),
    cacheReadTokens: sum((call) => call.cacheReadTokens),
    cacheCreationTokens: sum((call) => call.cacheCreationTokens),
    webSearchRequests: sum((call) => call.webSearchRequests),
    costUsd: anyCost ? sum((call) => call.costUsd) : undefined,
    collectionSpanMs: collection
      ? Date.parse(collection.lastCapturedAt) - Date.parse(collection.firstCapturedAt)
      : undefined,
  };
}

/** Mutable collector handed to pipeline stages while a run executes. */
export class RunMetricsCollector {
  #llmCalls: LlmCallMetrics[] = [];
  #stageDurationsMs: Record<string, number> = {};
  postsIn = 0;
  postsAfterHardFilter = 0;
  postsSelected = 0;
  funnel: FunnelCounts | undefined;
  bySource: SourceCount[] | undefined;
  collection: CollectionMetrics | undefined;

  recordLlmCall(call: LlmCallMetrics): void {
    this.#llmCalls.push(call);
  }

  recordStageDuration(stage: string, durationMs: number): void {
    this.#stageDurationsMs[stage] = (this.#stageDurationsMs[stage] ?? 0) + durationMs;
  }

  toRunMetrics(): RunMetrics {
    return {
      ...(this.collection ? { collection: this.collection } : {}),
      stageDurationsMs: { ...this.#stageDurationsMs },
      llmCalls: [...this.#llmCalls],
      postsIn: this.postsIn,
      postsAfterHardFilter: this.postsAfterHardFilter,
      postsSelected: this.postsSelected,
      ...(this.funnel ? { funnel: { ...this.funnel } } : {}),
      ...(this.bySource ? { bySource: this.bySource.map((count) => ({ ...count })) } : {}),
    };
  }
}
