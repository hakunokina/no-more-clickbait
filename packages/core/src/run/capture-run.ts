import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHardFilter, type HardFilterStats } from "../hard-filter.js";
import {
  CollectionMetricsSchema,
  countTimelineEntries,
  RunMetricsCollector,
  summarizeRunMetrics,
  type CollectionMetrics,
  type RunMetrics,
  type RunMetricsTotals,
} from "../metrics.js";
import {
  createThresholdSelector,
  runPipeline,
  type Scorer,
  type SelectorOptions,
} from "../pipeline.js";
import type { Post, RankedPost, ScoreEntry } from "../schemas.js";
import {
  parseHomeTimelineWithStats,
  type HomeTimelineParseStats,
  type HomeTimelineSkipReason,
} from "../x/home-timeline.js";

/**
 * Offline run over one developer-capture session directory (raw
 * HomeTimeline dumps + summary.json written by the native host):
 * parse → HardFilter → Scorer → Selector, no Verifier yet. Produces a
 * report with every score, the selection, the unjudged (media-only)
 * posts and the RunMetrics, for
 * measuring a real batch end to end. Captures are personal data: the
 * caller writes the report outside the repo (next to the capture).
 */

const CAPTURE_FILE = /HomeTimeline\.json$/;

export interface LoadedCapture {
  dir: string;
  /** Response dump file names, in capture order. */
  files: string[];
  /** Every parsed post, in feed order (duplicates/ads included). */
  posts: Post[];
  /** Parse stats summed over all responses. */
  parse: HomeTimelineParseStats;
  parseMs: number;
  /**
   * From summary.json when every dump is loaded; when the run is
   * limited to the first N dumps, derived from those dumps alone.
   */
  collection?: CollectionMetrics;
  /** Things the caller should surface (e.g. collection metrics dropped). */
  warnings: string[];
}

export interface LoadCaptureOptions {
  /** Load only the first N dumps (a session can keep growing later). */
  maxResponses?: number;
}

/** "0001-2026-10-15T10-51-23-009Z-HomeTimeline.json" → ISO time. */
function captureTimeOf(name: string): string | undefined {
  const match = /^\d+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(name);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : undefined;
}

function addParseStats(total: HomeTimelineParseStats, next: HomeTimelineParseStats): void {
  total.entries += next.entries;
  total.posts += next.posts;
  for (const [reason, n] of Object.entries(next.skipped)) {
    total.skipped[reason as HomeTimelineSkipReason] += n;
  }
}

export async function loadCapture(
  dir: string,
  options: LoadCaptureOptions = {},
): Promise<LoadedCapture> {
  const all = (await readdir(dir)).filter((name) => CAPTURE_FILE.test(name)).sort();
  if (all.length === 0) throw new Error(`no *HomeTimeline.json dumps in ${dir}`);
  const files = all.slice(0, options.maxResponses ?? all.length);
  const started = Date.now();
  const posts: Post[] = [];
  const rough = { postCount: 0, promotedCount: 0 };
  let parse: HomeTimelineParseStats | undefined;
  for (const name of files) {
    const payload = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
    const result = parseHomeTimelineWithStats(payload);
    const counts = countTimelineEntries(payload);
    rough.postCount += counts.postCount;
    rough.promotedCount += counts.promotedCount;
    posts.push(...result.posts);
    if (parse) addParseStats(parse, result.stats);
    else parse = result.stats;
  }
  const parseMs = Date.now() - started;

  let collection: CollectionMetrics | undefined;
  const warnings: string[] = [];
  if (files.length < all.length) {
    // summary.json covers the whole session; rebuild it for the subset
    // the way the native host does (times from the dump names).
    const first = captureTimeOf(files[0] as string);
    const last = captureTimeOf(files[files.length - 1] as string);
    if (first && last) {
      collection = {
        firstCapturedAt: first,
        lastCapturedAt: last,
        responseCount: files.length,
        ...rough,
      };
    } else {
      warnings.push(
        `collection metrics omitted: dump names "${files[0]}"/"${files[files.length - 1]}" ` +
          "do not match the <seq>-<ISO time>-HomeTimeline.json stamp",
      );
    }
  } else {
    try {
      const summary = CollectionMetricsSchema.safeParse(
        JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as unknown,
      );
      if (summary.success) collection = summary.data;
    } catch {
      // No summary: collection metrics are simply unknown for this run.
    }
  }
  return {
    dir,
    files,
    posts,
    parse: parse as HomeTimelineParseStats,
    parseMs,
    ...(collection ? { collection } : {}),
    warnings,
  };
}

export interface ScoreDistribution {
  /** Posts with a valid score (scoringFailed excluded). */
  scored: number;
  scoringFailed: number;
  /** Index i = posts with that 0-10 score. */
  clickbait: number[];
  readValue: number[];
  checkWorthy: number;
}

export function scoreDistribution(scores: readonly ScoreEntry[]): ScoreDistribution {
  const clickbait = new Array<number>(11).fill(0);
  const readValue = new Array<number>(11).fill(0);
  let checkWorthy = 0;
  let scoringFailed = 0;
  for (const score of scores) {
    if (score.scoringFailed) {
      scoringFailed += 1;
      continue;
    }
    clickbait[Math.round(score.clickbaitScore * 10)]! += 1;
    readValue[Math.round(score.readWorthinessScore * 10)]! += 1;
    if (score.checkWorthy) checkWorthy += 1;
  }
  return {
    scored: scores.length - scoringFailed,
    scoringFailed,
    clickbait,
    readValue,
    checkWorthy,
  };
}

export interface CaptureRunOptions {
  scorer: Scorer;
  /** Shared with the scorer so its LLM calls land in the same metrics. */
  metrics: RunMetricsCollector;
  selector: SelectorOptions;
  timelineSize: number;
}

export interface CaptureRunReport {
  captureDir: string;
  files: number;
  collection?: CollectionMetrics;
  parse: HomeTimelineParseStats;
  hardFilter: HardFilterStats;
  selector: SelectorOptions & { timelineSize: number; candidates: number };
  /** Every scorer judgement, in the scored posts' feed order. */
  scores: ScoreEntry[];
  distribution: ScoreDistribution;
  selected: RankedPost[];
  /** Media-only posts passed through unscored, outside the selection count. */
  unjudged: Post[];
  metrics: RunMetrics;
  totals: RunMetricsTotals;
}

export async function runCapture(
  capture: LoadedCapture,
  options: CaptureRunOptions,
): Promise<CaptureRunReport> {
  const { metrics } = options;
  metrics.recordStageDuration("parse", capture.parseMs);
  const hardFilter = createHardFilter();
  let scores: ScoreEntry[] = [];
  let candidates = 0;
  const selector = createThresholdSelector(options.selector);

  const result = await runPipeline(
    {
      hardFilter,
      scorer: {
        async score(posts) {
          scores = [...(await options.scorer.score(posts))];
          return scores;
        },
      },
      selector: {
        select(scored) {
          const ranked = selector.select(scored);
          candidates = ranked.length;
          return ranked;
        },
      },
    },
    capture.posts,
    {
      timelineSize: options.timelineSize,
      verifyConcurrency: 1,
      metrics,
      ...(capture.collection ? { collection: capture.collection } : {}),
    },
  );

  return {
    captureDir: capture.dir,
    files: capture.files.length,
    ...(capture.collection ? { collection: capture.collection } : {}),
    parse: capture.parse,
    hardFilter: hardFilter.stats,
    selector: { ...options.selector, timelineSize: options.timelineSize, candidates },
    scores,
    distribution: scoreDistribution(scores),
    selected: result.posts,
    unjudged: result.unjudged,
    metrics: result.metrics,
    totals: summarizeRunMetrics(result.metrics),
  };
}

/** Collapses a field onto one Markdown line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function scoreTags(score: ScoreEntry, post: Post, readFirst: boolean): string[] {
  const read = `okuma ${Math.round(score.readWorthinessScore * 10)}/10`;
  const clickbait = `clickbait ${Math.round(score.clickbaitScore * 10)}/10`;
  return [
    ...(readFirst ? [read, clickbait] : [clickbait, read]),
    ...(score.checkWorthy ? ["doğrulanmalı"] : []),
    ...(post.mediaOnly ? ["yalnız medya"] : []),
  ];
}

/** Text, quote and link lines of one post (scores excluded). */
function postBody(post: Post): string[] {
  const lines: string[] = [];
  if (post.repostedBy) lines.push(`_@${post.repostedBy} yeniden paylaştı_`, "");
  lines.push(post.text ? `> ${oneLine(post.text)}` : "> _(metin yok)_", "");
  if (post.quoted)
    lines.push(`> ↳ @${post.quoted.authorHandle}: ${oneLine(post.quoted.text)}`, "");
  return lines;
}

/**
 * The selection as a local, human-readable Markdown file (scores, text,
 * link), followed by the unjudged (media-only) posts as a separate
 * list. It holds feed content: written next to the capture only.
 */
export function renderSelectedMarkdown(report: CaptureRunReport): string {
  const s = report.selector;
  const lines = [
    `# Seçilen ${report.selected.length} gönderi`,
    "",
    `Kural: clickbait < ${s.maxClickbaitScore * 10}, okuma değeri tabanı ≥ ${s.minReadWorthinessScore * 10} ` +
      `(0-10) · sıralama: okuma değeri ↓, clickbait ↑ · ilk ${s.timelineSize} · ` +
      `kuralı geçen aday: ${s.candidates}`,
    "",
  ];
  for (const [index, { post, score }] of report.selected.entries()) {
    lines.push(
      `## ${index + 1}. @${post.authorHandle} — ${scoreTags(score, post, true).join(" · ")}`,
      "",
    );
    lines.push(...postBody(post));
    if (score.checkWorthyClaim) lines.push(`- İddia: ${oneLine(score.checkWorthyClaim)}`);
    if (score.reason) lines.push(`- Gerekçe: ${oneLine(score.reason)}`);
    lines.push(`- Bağlantı: ${post.url}`, "");
  }
  lines.push(
    `# Yargılanamaz: ${report.unjudged.length} gönderi`,
    "",
    "Yalnız medya (metin yok): puanlanmadı, sıralamaya ve seçilen sayısına dahil değil.",
    "",
  );
  for (const [index, post] of report.unjudged.entries()) {
    const kinds = [...new Set(post.media.map((media) => media.type))].join(", ") || "medya";
    lines.push(`## ${index + 1}. @${post.authorHandle} — ${kinds}`, "");
    if (post.repostedBy) lines.push(`_@${post.repostedBy} yeniden paylaştı_`, "");
    lines.push(`- Bağlantı: ${post.url}`, "");
  }
  return lines.join("\n");
}

/**
 * The highest-clickbait judgements, for checking that the filter drops
 * the right posts: clickbait ↓ (lower read value, then feed order,
 * breaking ties), each with scores, reason, text, quote and link.
 * Unscored placeholders (scoringFailed) are left out — their clickbait
 * 1 is not a judgement. `posts` is the run's input (e.g. the loaded
 * capture); feed content, so the file stays next to the capture.
 */
export function renderClickbaitTopMarkdown(
  report: CaptureRunReport,
  posts: readonly Post[],
  limit = 40,
): string {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const judged = report.scores
    .filter((score) => !score.scoringFailed)
    .map((score, order) => ({ score, order, post: byId.get(score.postId) }))
    .filter((entry): entry is typeof entry & { post: Post } => entry.post !== undefined)
    .sort(
      (a, b) =>
        b.score.clickbaitScore - a.score.clickbaitScore ||
        a.score.readWorthinessScore - b.score.readWorthinessScore ||
        a.order - b.order,
    )
    .slice(0, limit);
  const lines = [
    `# En yüksek clickbait: ilk ${judged.length} gönderi`,
    "",
    `Sıralama: clickbait ↓, okuma değeri ↑ · puanlanan: ${report.distribution.scored} · ` +
      `seçimden düşme sınırı: clickbait ≥ ${report.selector.maxClickbaitScore * 10}`,
    "",
  ];
  for (const [index, { post, score }] of judged.entries()) {
    lines.push(
      `## ${index + 1}. @${post.authorHandle} — ${scoreTags(score, post, false).join(" · ")}`,
      "",
    );
    lines.push(...postBody(post));
    lines.push(`- Gerekçe: ${score.reason ? oneLine(score.reason) : "_gerekçe yok_"}`);
    if (score.checkWorthyClaim) lines.push(`- İddia: ${oneLine(score.checkWorthyClaim)}`);
    lines.push(`- Bağlantı: ${post.url}`, "");
  }
  return lines.join("\n");
}
