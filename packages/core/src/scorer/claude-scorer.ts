import { z } from "zod";
import {
  CliRunError,
  createClaudeCliProvider,
  llmResultToCallMetrics,
  type ClaudeCliOptions,
  type CliLlmProvider,
  type LlmProvider,
  type LlmResult,
} from "../llm/cli-provider.js";
import type { RunMetricsCollector } from "../metrics.js";
import type { Scorer } from "../pipeline.js";
import type { Post, ScoreEntry } from "../schemas.js";
import { buildScorerPrompt, SCORER_SYSTEM_PROMPT } from "./scorer-prompt.js";

/**
 * Phase 1 Scorer: one LLM call scores the whole (hard-filtered) batch.
 * The LLM only judges — 0..10 scores, a check-worthy flag/claim and at
 * most a short reason per post; thresholds and ranking stay in code
 * (Selector). The reply format is one compact pipe-separated line per
 * post (see scorer-prompt.ts for why not JSON: output volume and
 * truncation): `seq|clickbait|readValue|check|claim|reason`, where
 * `seq` is the post's line number in the input block.
 *
 * Failure handling: ids missing from the reply, or whose line fails
 * the schema, get exactly ONE extra call containing only those posts.
 * Because completed lines survive a truncated reply, that retry only
 * ever carries the genuinely missing tail — never the whole batch
 * again, which is what made truncation fatal before. At the compact
 * line size the tail is far below any output limit. Ids still missing
 * afterwards come back marked `scoringFailed` with conservative
 * placeholder scores — visible, never silently dropped. Provider
 * errors on the first call propagate. On the retry only a CliRunError
 * (CLI exit/timeout/unparseable output) is absorbed: the first call's
 * scores stay and only the still-missing ids are marked
 * `scoringFailed`. Everything else — CLI missing, not logged in, or an
 * unexpected bug — propagates. A failed call is still recorded in the
 * run metrics (`failed: true`, timing only), so its time is visible.
 */

export const ClaudeScorerEntrySchema = z
  .object({
    id: z.string().min(1),
    /** 0 = straight reporting, 10 = pure clickbait. */
    clickbait: z.number().int().min(0).max(10),
    /** 0 = not worth the reader's time, 10 = highly worth reading. */
    readValue: z.number().int().min(0).max(10),
    checkWorthy: z.boolean(),
    /** The single most check-worthy claim; only when checkWorthy. */
    claim: z.string().min(1).max(500).nullable(),
    /**
     * Short justification. The prompt asks for one (≤6 words) only when
     * checkWorthy or clickbait ≥ 7 — a reason on every post was most
     * of the old output volume and explains nothing for plain posts.
     * Validity does not hinge on it: a missing reason never sends an
     * otherwise-good line to the retry.
     */
    reason: z.string().min(1).max(200).nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.checkWorthy && entry.claim === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: "claim is required when checkWorthy is true",
      });
    }
    if (!entry.checkWorthy && entry.claim !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: "claim must be null when checkWorthy is false",
      });
    }
  });
export type ClaudeScorerEntry = z.infer<typeof ClaudeScorerEntrySchema>;

/** Splits on the first `max` separators; the tail stays in one piece. */
function splitLine(line: string, max: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (parts.length < max) {
    const at = rest.indexOf("|");
    if (at === -1) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

/** A whole non-negative integer field, else NaN (which zod rejects). */
function intField(raw: string | undefined): number {
  return raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
}

function textField(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

/**
 * Parses the model's reply into the valid entries for the posts of
 * that call, addressed by sequence number and mapped back onto ids
 * (`orderedIds[seq - 1]`). Lines are validated one by one with zod;
 * a broken or truncated line simply leaves its id missing (the
 * caller retries those), and prose/code fences around the lines are
 * ignored. Only the final line can be cut by an output limit (every
 * earlier line ended with a newline). Cut inside its reason field it
 * still yields its scores — the reason is cosmetic. Cut inside its
 * claim, the half claim would pass the schema, so a check-worthy final
 * line must have its claim closed by "|"; otherwise it is retried.
 */
export function parseScorerOutput(
  text: string,
  orderedIds: readonly string[],
): Map<string, ClaudeScorerEntry> {
  const valid = new Map<string, ClaudeScorerEntry>();
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!/^\d+\|/.test(line)) continue;
    const [seqRaw, clickbaitRaw, readValueRaw, checkRaw, claimRaw, reasonRaw] = splitLine(
      line,
      5,
    );
    const isFinalLine = index === lines.length - 1;
    if (isFinalLine && checkRaw?.trim() === "1" && reasonRaw === undefined) continue;
    const seq = intField(seqRaw);
    const id = Number.isInteger(seq) ? orderedIds[seq - 1] : undefined;
    if (id === undefined || valid.has(id)) continue;
    const parsed = ClaudeScorerEntrySchema.safeParse({
      id,
      clickbait: intField(clickbaitRaw),
      readValue: intField(readValueRaw),
      checkWorthy:
        checkRaw?.trim() === "1" ? true : checkRaw?.trim() === "0" ? false : checkRaw,
      claim: textField(claimRaw),
      reason: textField(reasonRaw),
    });
    if (parsed.success) valid.set(id, parsed.data);
  }
  return valid;
}

function toScoreEntry(entry: ClaudeScorerEntry): ScoreEntry {
  return {
    postId: entry.id,
    clickbaitScore: entry.clickbait / 10,
    readWorthinessScore: entry.readValue / 10,
    checkWorthy: entry.checkWorthy,
    checkWorthyClaim: entry.claim,
    ...(entry.reason !== null ? { reason: entry.reason } : {}),
    scoringFailed: false,
  };
}

function unscoredEntry(postId: string): ScoreEntry {
  return {
    postId,
    clickbaitScore: 1,
    readWorthinessScore: 0,
    checkWorthy: false,
    checkWorthyClaim: null,
    reason: "unscored: no valid score returned after one retry",
    scoringFailed: true,
  };
}

/**
 * The `claude` CLI settings the Scorer is measured and tuned with.
 * The model is pinned so cost, speed and judgement do not silently
 * follow whatever default model the user configured for their own CLI.
 * Effort "low": thinking tokens count as output, and at the CLI
 * default they were over half of the reply (563 of 1000 tokens, 10
 * posts) for no change in judgement — at "low" the same batch took
 * 412 tokens, 0 thinking, with no score moving by 2+ and no
 * check-worthy flag flipping (smoke test, 10 synthetic posts).
 * isolateUserSettings: the user's CLAUDE.md, hooks and other personal
 * settings stay out of the call (privacy + the same judgement on every
 * machine). Fixed per-call overhead (trivial call, claude 2.1.300,
 * OAuth login): ≈4.67k input tokens with the CLI's agent prompt →
 * 2211 with the Scorer's own system prompt → 624 with
 * isolateUserSettings on top.
 */
export const CLAUDE_SCORER_CLI_DEFAULTS = {
  model: "claude-opus-5-5",
  effort: "low",
  isolateUserSettings: true,
} as const satisfies ClaudeCliOptions;

/**
 * The `claude` CLI provider with the Scorer's pinned settings. Options
 * explicitly set to `undefined` are skipped, so `{ model: undefined }`
 * keeps the pinned model instead of falling back to the CLI default.
 */
export function createClaudeScorerProvider(options: ClaudeCliOptions = {}): CliLlmProvider {
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as ClaudeCliOptions;
  return createClaudeCliProvider({ ...CLAUDE_SCORER_CLI_DEFAULTS, ...defined });
}

export interface ClaudeScorerOptions {
  provider: LlmProvider;
  /**
   * Metrics sink shared with the pipeline run; every LLM call (first
   * pass and the possible retry) is recorded as an LlmCallMetrics.
   */
  metrics?: RunMetricsCollector;
}

export function createClaudeScorer(options: ClaudeScorerOptions): Scorer {
  const { provider, metrics } = options;

  async function callOnce(posts: readonly Post[]): Promise<Map<string, ClaudeScorerEntry>> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let result: LlmResult;
    try {
      // No allowedTools: the provider hard-disables the tool set, so feed
      // content has nothing to invoke even under prompt injection.
      // Instructions as the system prompt, the post data block as the
      // user message: feed content never shares a message with them.
      result = await provider.complete({
        systemPrompt: SCORER_SYSTEM_PROMPT,
        prompt: buildScorerPrompt(posts),
      });
    } catch (error) {
      metrics?.recordLlmCall({
        providerId: provider.id,
        stage: "scorer",
        startedAt,
        durationMs: Date.now() - started,
        postCount: posts.length,
        failed: true,
      });
      throw error;
    }
    metrics?.recordLlmCall({
      ...llmResultToCallMetrics(provider.id, "scorer", startedAt, result),
      postCount: posts.length,
    });
    return parseScorerOutput(
      result.text,
      posts.map((post) => post.id),
    );
  }

  return {
    async score(posts) {
      if (posts.length === 0) return [];
      const byId = await callOnce(posts);
      const missing = posts.filter((post) => !byId.has(post.id));
      if (missing.length > 0) {
        try {
          for (const [id, entry] of await callOnce(missing)) byId.set(id, entry);
        } catch (error) {
          if (!(error instanceof CliRunError)) throw error;
          // Retry failed (CLI exit, timeout): keep the first call's scores;
          // the still-missing ids fall through to unscoredEntry below.
        }
      }
      return posts.map((post) => {
        const entry = byId.get(post.id);
        return entry ? toScoreEntry(entry) : unscoredEntry(post.id);
      });
    },
  };
}
