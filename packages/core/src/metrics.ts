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
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
  /** Provider-reported cost in USD, when the provider reports one. */
  costUsd: z.number().nonnegative().optional(),
});
export type LlmCallMetrics = z.infer<typeof LlmCallMetricsSchema>;

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
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export interface RunMetricsTotals {
  llmCallCount: number;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
    totalDurationMs: sum((call) => call.durationMs),
    inputTokens: sum((call) => call.inputTokens),
    outputTokens: sum((call) => call.outputTokens),
    cacheReadTokens: sum((call) => call.cacheReadTokens),
    cacheCreationTokens: sum((call) => call.cacheCreationTokens),
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
    };
  }
}
