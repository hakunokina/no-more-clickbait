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
  /** Posts captured across all timeline responses in the run. */
  postCount: z.number().int().nonnegative(),
});
export type CollectionMetrics = z.infer<typeof CollectionMetricsSchema>;

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
