import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RunMetricsCollector, summarizeRunMetrics } from "../metrics.js";
import { DEFAULT_MAX_VERIFICATIONS, DEFAULT_MIN_READ_FOR_VERIFY } from "../pipeline.js";
import { createClaudeScorer, createClaudeScorerProvider } from "../scorer/claude-scorer.js";
import {
  createClaudeVerifier,
  createClaudeVerifierProvider,
} from "../verifier/claude-verifier.js";
import {
  loadCapture,
  renderClickbaitTopMarkdown,
  renderSelectedMarkdown,
  runCapture,
} from "./capture-run.js";

/**
 * nmc-run: one measured pipeline run over a capture session directory.
 *
 *   pnpm build
 *   pnpm --filter @nmc/core nmc-run --capture <dir> [--out <result.json>]
 *       [--top 50] [--max-clickbait 7] [--min-read 2] [--responses N]
 *       [--no-verify] [--max-verify 20] [--verify-concurrency 4]
 *       [--min-read-verify 5]
 *
 * Selection: clickbait < --max-clickbait, ranked by read value
 * (clickbait breaking ties), the first --top taken; --min-read is only
 * a floor, so the timeline ends shorter when it leaves fewer posts.
 * Media-only posts are not scored; they are listed separately as
 * unjudged, outside the --top count.
 *
 * Verification is on by default: check-worthy claims among the selected
 * posts with read value ≥ --min-read-verify get one web-search call
 * each (at most --max-verify per run, higher read value first,
 * --verify-concurrency in parallel); posts whose claim sources
 * contradict are replaced from further down the list.
 * --no-verify skips the stage.
 *
 * --responses N runs on the first N dumps only (a capture session can
 * keep growing after the measured batch); collection metrics are then
 * rebuilt from those dumps instead of summary.json.
 *
 * Output (default: a "<capture>-run-<time>" folder NEXT TO the capture,
 * outside the repo): result.json (report + RunMetrics), selected.md
 * (the selection + unjudged list, readable) and clickbait-top.md (the
 * 40 highest-clickbait judgements, to audit the filter). All hold feed
 * content — personal data.
 * Stdout carries counts only.
 */

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    out: { type: "string" },
    top: { type: "string", default: "50" },
    "max-clickbait": { type: "string", default: "7" },
    "min-read": { type: "string", default: "2" },
    responses: { type: "string" },
    "no-verify": { type: "boolean", default: false },
    "max-verify": { type: "string", default: String(DEFAULT_MAX_VERIFICATIONS) },
    "verify-concurrency": { type: "string", default: "4" },
    "min-read-verify": { type: "string", default: String(DEFAULT_MIN_READ_FOR_VERIFY * 10) },
  },
});

function intOption(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name} must be an integer in ${min}..${max}`);
  }
  return n;
}

if (!values.capture) {
  console.error("usage: nmc-run --capture <capture-dir> [--out <result.json>]");
  process.exit(2);
}
const captureDir = resolve(values.capture);
const top = intOption("top", values.top, 1, 1000);
const maxClickbait = intOption("max-clickbait", values["max-clickbait"], 1, 11);
const minRead = intOption("min-read", values["min-read"], 0, 10);
const maxResponses =
  values.responses !== undefined
    ? intOption("responses", values.responses, 1, 100_000)
    : undefined;
const verify = !values["no-verify"];
const maxVerify = intOption("max-verify", values["max-verify"], 1, DEFAULT_MAX_VERIFICATIONS);
const verifyConcurrency = intOption("verify-concurrency", values["verify-concurrency"], 1, 20);
const minReadVerify = intOption("min-read-verify", values["min-read-verify"], 0, 10);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = values.out
  ? resolve(values.out)
  : join(`${captureDir.replace(/[\\/]+$/, "")}-run-${stamp}`, "result.json");

const provider = createClaudeScorerProvider();
const availability = await provider.checkAvailable();
if (!availability.ok) {
  console.error(`claude CLI not ready (${availability.reason}): ${availability.detail}`);
  process.exit(1);
}

const capture = await loadCapture(
  captureDir,
  maxResponses !== undefined ? { maxResponses } : {},
);
for (const warning of capture.warnings) console.error(`warning: ${warning}`);
const metrics = new RunMetricsCollector();
const report = await runCapture(capture, {
  scorer: createClaudeScorer({ provider, metrics }),
  metrics,
  selector: { maxClickbaitScore: maxClickbait / 10, minReadWorthinessScore: minRead / 10 },
  timelineSize: top,
  ...(verify
    ? {
        verifier: createClaudeVerifier({ provider: createClaudeVerifierProvider(), metrics }),
        verifyConcurrency,
        maxVerifications: maxVerify,
        minReadForVerify: minReadVerify / 10,
      }
    : {}),
});

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const selectedFile = join(dirname(outFile), "selected.md");
await writeFile(selectedFile, renderSelectedMarkdown(report), "utf8");
const clickbaitTopFile = join(dirname(outFile), "clickbait-top.md");
await writeFile(clickbaitTopFile, renderClickbaitTopMarkdown(report, capture.posts), "utf8");

const t = report.totals;
const stageTotals = (stage: string) => {
  const totals = summarizeRunMetrics({
    ...report.metrics,
    llmCalls: report.metrics.llmCalls.filter((call) => call.stage === stage),
  });
  return {
    calls: totals.llmCallCount,
    failedCalls: totals.failedCallCount,
    llmMs: totals.totalDurationMs,
    totalInputTokens: totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens,
    outputTokens: totals.outputTokens,
    thinkingTokens: totals.thinkingTokens,
    webSearchRequests: totals.webSearchRequests,
    costUsd: totals.costUsd,
  };
};
const v = report.verification;
console.log(
  JSON.stringify(
    {
      posts: report.parse.posts,
      afterHardFilter: report.hardFilter.kept,
      scored: report.distribution.scored,
      scoringFailed: report.distribution.scoringFailed,
      candidates: report.selector.candidates,
      selected: report.selected.length,
      unjudged: report.unjudged.length,
      llmCalls: t.llmCallCount,
      failedCalls: t.failedCallCount,
      llmMs: t.totalDurationMs,
      // inputTokens alone is only the uncached part; the total is what
      // the model actually read.
      totalInputTokens: t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens,
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      outputTokens: t.outputTokens,
      thinkingTokens: t.thinkingTokens,
      costUsd: t.costUsd,
      stageDurationsMs: report.metrics.stageDurationsMs,
      scorer: stageTotals("scorer"),
      verification: v
        ? {
            claims: v.calls,
            byStatus: v.byStatus,
            failed: v.failed,
            rejected: v.rejected,
            backfilled: v.backfilled,
            skippedBelowRead: v.skippedBelowRead,
            skippedOverBudget: v.skippedOverBudget,
            ...stageTotals("verifier"),
          }
        : "off",
    },
    null,
    2,
  ),
);
console.log(`result: ${outFile}`);
console.log(`selected: ${selectedFile}`);
console.log(`clickbait-top: ${clickbaitTopFile}`);
