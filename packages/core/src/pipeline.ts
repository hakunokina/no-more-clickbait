import { RunMetricsCollector, type CollectionMetrics, type RunMetrics } from "./metrics.js";
import type {
  Post,
  RankedPost,
  ScoreEntry,
  VerificationResult,
  VerificationStatus,
} from "./schemas.js";

/**
 * The pipeline. Orchestration lives in OUR code; the LLM only renders
 * judgements (Scorer, Verifier) and never decides ordering or cut-offs.
 *
 *   HardFilter (code) -> Scorer (one LLM call for all posts)
 *   -> Selector (code: ranking + floors) -> Verifier (one parallel
 *   LLM call per claim, bounded concurrency)
 *
 * Media-only posts (no text to judge) never reach the Scorer: they
 * bypass scoring and ranking and come back as a separate `unjudged`
 * list, outside the `timelineSize` count (owner's decision; how they
 * are presented is the renderer's call).
 *
 * The pipeline's output is the verified selection itself (JSON);
 * presentation is a separate, later concern.
 *
 * Which posts are verified is decided here, not by the model: only
 * check-worthy posts with a claim whose read value reaches
 * `minReadForVerify` (owner's decision), at most `maxVerifications` per
 * run, handed out in ranked order (higher read value first). Other
 * posts stay in unverified (`verification: null`). Posts whose claim
 * sources contradict (`false_or_disputed`) leave the selection — only
 * their count is reported — and are backfilled from further down the
 * ranked list under the same rules. `unverifiable` posts stay in,
 * carrying their status.
 */

/** Cheap, deterministic pre-filter implemented in plain code (no LLM). */
export interface HardFilter {
  keep(post: Post): boolean;
}

/** Scores every surviving post in a single call. */
export interface Scorer {
  score(posts: readonly Post[]): Promise<readonly ScoreEntry[]>;
}

export interface SelectorOptions {
  /** Posts at or above this clickbait score are dropped. */
  maxClickbaitScore: number;
  /**
   * Floor, not a quality bar: posts below it are dropped. The ranking
   * does the real selection (top `timelineSize`); when the floor leaves
   * fewer candidates, the timeline simply ends shorter (no padding).
   */
  minReadWorthinessScore: number;
}

export interface ScoredPost {
  post: Post;
  score: ScoreEntry;
}

/**
 * Applies the floors and returns candidates best-first: highest
 * read-worthiness first, lower clickbait breaking ties. Pure code.
 */
export interface Selector {
  select(scored: readonly ScoredPost[]): readonly ScoredPost[];
}

/** Verifies one claim of one post. Implementations run in parallel. */
export interface Verifier {
  verify(post: Post, claim: string): Promise<VerificationResult>;
}

export function createThresholdSelector(options: SelectorOptions): Selector {
  return {
    select(scored) {
      return scored
        .filter(
          ({ score }) =>
            score.clickbaitScore < options.maxClickbaitScore &&
            score.readWorthinessScore >= options.minReadWorthinessScore,
        )
        .sort(
          (a, b) =>
            b.score.readWorthinessScore - a.score.readWorthinessScore ||
            a.score.clickbaitScore - b.score.clickbaitScore,
        );
    },
  };
}

/** Runs async tasks with a bounded number in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError("concurrency limit must be >= 1");
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface PipelineOptions {
  /** How many posts the final selection contains. */
  timelineSize: number;
  /** Max simultaneous Verifier calls. */
  verifyConcurrency: number;
  /** Most Verifier calls in one run (default DEFAULT_MAX_VERIFICATIONS). */
  maxVerifications?: number;
  /**
   * Read-worthiness (0..1) a check-worthy post needs to be verified
   * (default DEFAULT_MIN_READ_FOR_VERIFY). Below it the post stays in
   * unverified.
   */
  minReadForVerify?: number;
  /** Collection span/count for the run, when known (feeds the monitor). */
  collection?: CollectionMetrics;
  /**
   * Metrics sink. LLM-backed stage implementations record their calls
   * here (see llmResultToCallMetrics); runPipeline fills stage timings
   * and post counters. A fresh collector is created when not supplied.
   */
  metrics?: RunMetricsCollector;
}

export interface Pipeline {
  hardFilter: HardFilter;
  scorer: Scorer;
  selector: Selector;
  /**
   * Optional: without one, the top `timelineSize` candidates are taken
   * as ranked and every post carries `verification: null` (measurement
   * runs before verification exists).
   */
  verifier?: Verifier;
}

/** Owner's ceiling on verification calls per run. */
export const DEFAULT_MAX_VERIFICATIONS = 20;

/** Owner's floor: only posts with read value ≥ 5/10 are worth a check. */
export const DEFAULT_MIN_READ_FOR_VERIFY = 0.5;

export interface VerificationStats {
  /** Verifier calls made (= results.length). */
  calls: number;
  /** Results per status, failed calls included under `unverifiable`. */
  byStatus: Record<VerificationStatus, number>;
  /** Calls that yielded no judgement (CLI error, timeout, bad reply). */
  failed: number;
  /** Posts verification removed from the selection (count only). */
  rejected: number;
  /** Selected posts added from further down the list to replace them. */
  backfilled: number;
  /** Check-worthy posts left unverified: read value below the floor. */
  skippedBelowRead: number;
  /** Check-worthy posts left unverified because the budget ran out. */
  skippedOverBudget: number;
  /** Every verification made, in rank order (rejected ones included). */
  results: VerificationResult[];
}

export interface PipelineRunResult {
  /** The verified final selection — this JSON is the pipeline's output. */
  posts: RankedPost[];
  /**
   * Media-only posts that passed the hard filter, in feed order: not
   * scored, not ranked, not counted against `timelineSize`.
   */
  unjudged: Post[];
  /** Absent when the pipeline has no Verifier. */
  verification?: VerificationStats;
  metrics: RunMetrics;
}

function isCheckWorthy(score: ScoreEntry): boolean {
  return score.checkWorthy !== false && score.checkWorthyClaim !== null;
}

export async function runPipeline(
  pipeline: Pipeline,
  posts: readonly Post[],
  options: PipelineOptions,
): Promise<PipelineRunResult> {
  const metrics = options.metrics ?? new RunMetricsCollector();
  if (options.collection) metrics.collection = options.collection;
  metrics.postsIn = posts.length;

  const timed = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      metrics.recordStageDuration(stage, Date.now() - started);
    }
  };

  const kept = await timed("hardFilter", () =>
    posts.filter((post) => pipeline.hardFilter.keep(post)),
  );
  metrics.postsAfterHardFilter = kept.length;
  const unjudged = kept.filter((post) => post.mediaOnly);
  const judgeable = kept.filter((post) => !post.mediaOnly);
  if (judgeable.length === 0) return { posts: [], unjudged, metrics: metrics.toRunMetrics() };

  const scores = await timed("scorer", () => pipeline.scorer.score(judgeable));
  const byId = new Map(scores.map((score) => [score.postId, score]));
  const scored: ScoredPost[] = judgeable.flatMap((post) => {
    const score = byId.get(post.id);
    return score ? [{ post, score }] : [];
  });

  const candidates = await timed("selector", () => pipeline.selector.select(scored));
  const verifier = pipeline.verifier;
  if (!verifier) {
    const accepted = candidates
      .slice(0, options.timelineSize)
      .map((candidate) => ({ ...candidate, verification: null }));
    metrics.postsSelected = accepted.length;
    return { posts: accepted, unjudged, metrics: metrics.toRunMetrics() };
  }
  const accepted: RankedPost[] = [];
  const stats: VerificationStats = {
    calls: 0,
    byStatus: { verified: 0, false_or_disputed: 0, unverifiable: 0 },
    failed: 0,
    rejected: 0,
    backfilled: 0,
    skippedBelowRead: 0,
    skippedOverBudget: 0,
    results: [],
  };
  let budget = options.maxVerifications ?? DEFAULT_MAX_VERIFICATIONS;
  const minRead = options.minReadForVerify ?? DEFAULT_MIN_READ_FOR_VERIFY;

  // Verify in ranked order, in bounded-parallel windows. A rejected post
  // is dropped and backfilled by the next candidate down the list.
  let cursor = 0;
  while (accepted.length < options.timelineSize && cursor < candidates.length) {
    const needed = options.timelineSize - accepted.length;
    const window = candidates.slice(cursor, cursor + needed);
    const isBackfill = cursor > 0;
    cursor += window.length;

    // Budget is handed out in rank order before the parallel calls start.
    const toVerify = window.map(({ score }) => {
      if (!isCheckWorthy(score)) return false;
      if (score.readWorthinessScore < minRead) {
        stats.skippedBelowRead += 1;
        return false;
      }
      if (budget <= 0) {
        stats.skippedOverBudget += 1;
        return false;
      }
      budget -= 1;
      return true;
    });
    const verified = await timed("verifier", () =>
      mapWithConcurrency(
        window.map((candidate, index) => ({ candidate, check: toVerify[index] === true })),
        options.verifyConcurrency,
        async ({ candidate, check }) => {
          const claim = candidate.score.checkWorthyClaim;
          const verification =
            check && claim !== null ? await verifier.verify(candidate.post, claim) : null;
          return { ...candidate, verification };
        },
      ),
    );

    for (const entry of verified) {
      const verification = entry.verification;
      if (verification) {
        stats.calls += 1;
        stats.byStatus[verification.status] += 1;
        if (verification.failed) stats.failed += 1;
        stats.results.push(verification);
        if (verification.status === "false_or_disputed") {
          stats.rejected += 1;
          continue;
        }
      }
      accepted.push(entry);
      if (isBackfill) stats.backfilled += 1;
    }
  }

  metrics.postsSelected = accepted.length;
  return { posts: accepted, unjudged, verification: stats, metrics: metrics.toRunMetrics() };
}
