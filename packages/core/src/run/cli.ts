import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RunMetricsCollector } from "../metrics.js";
import { createClaudeScorer, createClaudeScorerProvider } from "../scorer/claude-scorer.js";
import { loadCapture, renderSelectedMarkdown, runCapture } from "./capture-run.js";

/**
 * nmc-run: one measured pipeline run over a capture session directory.
 *
 *   pnpm build
 *   pnpm --filter @nmc/core nmc-run --capture <dir> [--out <result.json>]
 *       [--top 50] [--max-clickbait 7] [--min-read 5] [--responses N]
 *
 * --responses N runs on the first N dumps only (a capture session can
 * keep growing after the measured batch); collection metrics are then
 * rebuilt from those dumps instead of summary.json.
 *
 * Output (default: a "<capture>-run-<time>" folder NEXT TO the capture,
 * outside the repo): result.json (report + RunMetrics) and selected.md
 * (the selection, readable). Both hold feed content — personal data.
 * Stdout carries counts only.
 */

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    out: { type: "string" },
    top: { type: "string", default: "50" },
    "max-clickbait": { type: "string", default: "7" },
    "min-read": { type: "string", default: "5" },
    responses: { type: "string" },
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
const metrics = new RunMetricsCollector();
const report = await runCapture(capture, {
  scorer: createClaudeScorer({ provider, metrics }),
  metrics,
  selector: { maxClickbaitScore: maxClickbait / 10, minReadWorthinessScore: minRead / 10 },
  timelineSize: top,
});

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const selectedFile = join(dirname(outFile), "selected.md");
await writeFile(selectedFile, renderSelectedMarkdown(report), "utf8");

const t = report.totals;
console.log(
  JSON.stringify(
    {
      posts: report.parse.posts,
      afterHardFilter: report.hardFilter.kept,
      scored: report.distribution.scored,
      scoringFailed: report.distribution.scoringFailed,
      candidates: report.selector.candidates,
      selected: report.selected.length,
      llmCalls: t.llmCallCount,
      failedCalls: t.failedCallCount,
      llmMs: t.totalDurationMs,
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      outputTokens: t.outputTokens,
      thinkingTokens: t.thinkingTokens,
      costUsd: t.costUsd,
      stageDurationsMs: report.metrics.stageDurationsMs,
    },
    null,
    2,
  ),
);
console.log(`result: ${outFile}`);
console.log(`selected: ${selectedFile}`);
