import { RunMetricsCollector, type CollectionMetrics, type RunMetrics } from "./metrics.js";
import type { Post, RankedPost, ScoreEntry, VerificationResult } from "./schemas.js";

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
 * Posts rejected by verification are backfilled from further down the
 * ranked candidate list until the timeline is full or candidates run out.
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

export interface PipelineRunResult {
  /** The verified final selection — this JSON is the pipeline's output. */
  posts: RankedPost[];
  /**
   * Media-only posts that passed the hard filter, in feed order: not
   * scored, not ranked, not counted against `timelineSize`.
   */
  unjudged: Post[];
  metrics: RunMetrics;
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

  // Verify in ranked order, in bounded-parallel windows. A contradicted
  // post is dropped and backfilled by the next candidate down the list.
  let cursor = 0;
  while (accepted.length < options.timelineSize && cursor < candidates.length) {
    const needed = options.timelineSize - accepted.length;
    const window = candidates.slice(cursor, cursor + needed);
    cursor += window.length;

    const verified = await timed("verifier", () =>
      mapWithConcurrency(window, options.verifyConcurrency, async (candidate) => {
        const claim = candidate.score.checkWorthyClaim;
        const verification =
          claim === null ? null : await verifier.verify(candidate.post, claim);
        return { ...candidate, verification };
      }),
    );

    for (const entry of verified) {
      if (entry.verification?.verdict === "contradicted") continue;
      accepted.push(entry);
      if (accepted.length >= options.timelineSize) break;
    }
  }

  metrics.postsSelected = accepted.length;
  return { posts: accepted, unjudged, metrics: metrics.toRunMetrics() };
}
