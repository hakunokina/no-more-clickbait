import {
  createHardFilter,
  createThresholdSelector,
  feedItemKey,
  pipelineConfigFromSettings,
  runPipeline,
  RunMetricsCollector,
  summarizeRunMetrics,
  type CollectionMetrics,
  type FeedItem,
  type PipelineRunResult,
  type RunMetrics,
  type ScoreEntry,
  type Scorer,
  type Settings,
  type Verifier,
} from "@nmc/core";
import {
  CliNotAuthenticatedError,
  CliNotFoundError,
  CliRunError,
  type LlmAvailability,
} from "@nmc/core/llm";
import {
  EMPTY_COUNTS,
  type RunCounts,
  type RunError,
  type RunStage,
  type UsageTotals,
} from "../shared/status.js";
import { note } from "../shared/i18n.js";

/**
 * Runs the pipeline (HardFilter → Scorer → Selector → Verifier) for one
 * collection session in the main process: one run at a time, cancellable,
 * reporting live progress (stage, counts, token usage) for the monitor.
 *
 * The LLM stages are injected (`CreateStages`): production wires the
 * `claude` CLI providers (claude-stages.ts), tests wire fakes. Cancel
 * stops the run at once and asks the stages to kill their CLI children.
 */

export interface RunStages {
  checkAvailable(): Promise<LlmAvailability>;
  scorer: Scorer;
  verifier: Verifier;
  /** Kills in-flight LLM subprocesses. */
  cancel(): void;
}

/** Stages share the run's metrics collector so their calls are counted. */
export type CreateStages = (metrics: RunMetricsCollector) => RunStages;

export interface RunProgress {
  stage: Extract<RunStage, "checking" | "filtering" | "scoring" | "verifying">;
  counts: RunCounts;
  usage: UsageTotals;
  stageDurationsMs: Record<string, number>;
}

export type RunOutcome =
  | { status: "done"; result: PipelineRunResult; counts: RunCounts }
  | { status: "cancelled"; metrics: RunMetrics }
  | { status: "error"; error: RunError; metrics: RunMetrics };

export class RunBusyError extends Error {
  constructor() {
    super("a pipeline run is already in progress");
    this.name = "RunBusyError";
  }
}

class CancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "CancelledError";
  }
}

export function usageOf(metrics: RunMetrics): UsageTotals {
  const totals = summarizeRunMetrics(metrics);
  return {
    llmCalls: totals.llmCallCount,
    failedCalls: totals.failedCallCount,
    inputTokens: totals.inputTokens,
    cacheTokens: totals.cacheReadTokens + totals.cacheCreationTokens,
    outputTokens: totals.outputTokens,
    thinkingTokens: totals.thinkingTokens,
    costUsd: totals.costUsd ?? null,
  };
}

function availabilityError(availability: Exclude<LlmAvailability, { ok: true }>): RunError {
  switch (availability.reason) {
    case "not-found":
      return {
        kind: "cli-not-found",
        note: note("errCliNotFound"),
        detail: availability.detail,
      };
    case "not-authenticated":
      return {
        kind: "cli-not-authenticated",
        note: note("errCliNotAuthenticated"),
        detail: availability.detail,
      };
    default:
      return {
        kind: "cli-error",
        note: note("errCliUnexpected"),
        detail: availability.detail,
      };
  }
}

export function classifyError(error: unknown): RunError {
  if (error instanceof CliNotFoundError) {
    return availabilityError({ ok: false, reason: "not-found", detail: error.message });
  }
  if (error instanceof CliNotAuthenticatedError) {
    return availabilityError({ ok: false, reason: "not-authenticated", detail: error.message });
  }
  if (error instanceof CliRunError) {
    return {
      kind: "cli-error",
      note: note("errCliFailed"),
      detail: error.message,
    };
  }
  return {
    kind: "internal",
    note: note("errInternal"),
    detail: error instanceof Error ? error.message : String(error),
  };
}

function isCheckWorthy(score: ScoreEntry): boolean {
  return score.checkWorthy !== false && score.checkWorthyClaim !== null;
}

interface ActiveRun {
  cancelled: boolean;
  stages: RunStages | null;
  abort: () => void;
}

export class PipelineRunner {
  readonly #createStages: CreateStages;
  #active: ActiveRun | null = null;

  constructor(createStages: CreateStages) {
    this.#createStages = createStages;
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  /** Stops the current run; false when nothing runs. */
  cancel(): boolean {
    const active = this.#active;
    if (!active || active.cancelled) return false;
    active.cancelled = true;
    active.stages?.cancel();
    active.abort();
    return true;
  }

  async run(
    posts: readonly FeedItem[],
    settings: Settings,
    onProgress: (progress: RunProgress) => void,
    collection?: CollectionMetrics,
  ): Promise<RunOutcome> {
    if (this.#active) throw new RunBusyError();
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new CancelledError());
    });
    // Never an unhandled rejection: the race below is its only reader.
    aborted.catch(() => undefined);
    const active: ActiveRun = { cancelled: false, stages: null, abort: () => abort() };
    this.#active = active;

    const metrics = new RunMetricsCollector();
    const counts: RunCounts = { ...EMPTY_COUNTS, postsIn: posts.length };
    const emit = (stage: RunProgress["stage"]): void => {
      if (active.cancelled) return;
      const snapshot = metrics.toRunMetrics();
      onProgress({
        stage,
        counts: { ...counts },
        usage: usageOf(snapshot),
        stageDurationsMs: snapshot.stageDurationsMs,
      });
    };
    const guard = (): void => {
      if (active.cancelled) throw new CancelledError();
    };

    try {
      emit("checking");
      const stages = this.#createStages(metrics);
      active.stages = stages;
      const availability = await Promise.race([stages.checkAvailable(), aborted]);
      if (!availability.ok) {
        return {
          status: "error",
          error: availabilityError(availability),
          metrics: metrics.toRunMetrics(),
        };
      }

      const config = pipelineConfigFromSettings(settings);
      const selector = createThresholdSelector(config.selector);
      let verifyStarted = 0;

      const scorer: Scorer = {
        async score(judgeable) {
          guard();
          counts.afterHardFilter = metrics.postsAfterHardFilter;
          counts.mediaOnly = metrics.postsAfterHardFilter - judgeable.length;
          emit("scoring");
          const scores = await stages.scorer.score(judgeable);
          guard();
          if (config.verify) {
            // Claims the ranked top would send to the Verifier; backfill may add more.
            const byId = new Map(scores.map((score) => [score.postId, score]));
            const top = selector
              .select(
                judgeable.flatMap((post) => {
                  const score = byId.get(feedItemKey(post));
                  return score ? [{ post, score }] : [];
                }),
              )
              .slice(0, config.timelineSize);
            const worthy = top.filter(
              ({ score }) =>
                isCheckWorthy(score) && score.readWorthinessScore >= config.minReadForVerify,
            ).length;
            counts.verifyTotal = Math.min(worthy, config.maxVerifications);
          }
          emit(counts.verifyTotal > 0 ? "verifying" : "scoring");
          return scores;
        },
      };
      const verifier: Verifier = {
        async verify(post, claim) {
          guard();
          verifyStarted += 1;
          counts.verifyTotal = Math.max(counts.verifyTotal, verifyStarted);
          emit("verifying");
          const result = await stages.verifier.verify(post, claim);
          guard();
          counts.verifyDone += 1;
          emit("verifying");
          return result;
        },
      };

      emit("filtering");
      const result = await Promise.race([
        runPipeline(
          {
            hardFilter: createHardFilter(),
            scorer,
            selector,
            ...(config.verify ? { verifier } : {}),
          },
          posts,
          {
            timelineSize: config.timelineSize,
            verifyConcurrency: 4,
            maxVerifications: config.maxVerifications,
            minReadForVerify: config.minReadForVerify,
            metrics,
            ...(collection ? { collection } : {}),
          },
        ),
        aborted,
      ]);
      counts.afterHardFilter = result.metrics.postsAfterHardFilter;
      counts.mediaOnly = result.unjudged.length;
      counts.selected = result.posts.length;
      const funnel = result.funnel;
      counts.filteredOut =
        funnel.scoringFailed +
        funnel.clickbait +
        funnel.belowReadFloor +
        funnel.contradicted +
        funnel.rankedOut;
      return { status: "done", result, counts: { ...counts } };
    } catch (error) {
      if (active.cancelled || error instanceof CancelledError) {
        return { status: "cancelled", metrics: metrics.toRunMetrics() };
      }
      return { status: "error", error: classifyError(error), metrics: metrics.toRunMetrics() };
    } finally {
      this.#active = null;
    }
  }
}
