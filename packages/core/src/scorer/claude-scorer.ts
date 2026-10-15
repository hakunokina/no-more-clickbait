import { z } from "zod";
import { llmResultToCallMetrics, type LlmProvider } from "../llm/cli-provider.js";
import type { RunMetricsCollector } from "../metrics.js";
import type { Scorer } from "../pipeline.js";
import type { Post, ScoreEntry } from "../schemas.js";
import { buildScorerPrompt } from "./scorer-prompt.js";

/**
 * Phase 1 Scorer: one LLM call scores the whole (hard-filtered) batch.
 * The LLM only judges — 0..10 scores, a check-worthy flag/claim and a
 * short reason per post; thresholds and ranking stay in code (Selector).
 *
 * Failure handling: ids missing from the reply, or whose entry fails
 * the schema, get exactly ONE extra call containing only those posts.
 * Ids still missing afterwards come back marked `scoringFailed` with
 * conservative placeholder scores — visible, never silently dropped.
 * Provider errors (CLI missing / not logged in) propagate instead:
 * they are actionable by the user, not per-post failures.
 */

export const ClaudeScorerEntrySchema = z
  .object({
    id: z.string().min(1),
    /** 0 = straight reporting, 10 = pure clickbait. */
    clickbait: z.number().min(0).max(10),
    /** 0 = not worth the reader's time, 10 = highly worth reading. */
    readValue: z.number().min(0).max(10),
    checkWorthy: z.boolean(),
    /** The single most check-worthy claim; only when checkWorthy. */
    claim: z.string().min(1).max(500).nullable(),
    reason: z.string().min(1).max(500),
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

const ScorerOutputShapeSchema = z.object({ scores: z.array(z.unknown()) });

/**
 * Parses the model's reply into the valid entries for `expectedIds`.
 * Tolerates code fences / surrounding prose around the JSON object;
 * unknown (hallucinated) ids and schema-invalid entries are ignored —
 * the caller sees those ids as missing and retries them.
 */
export function parseScorerOutput(
  text: string,
  expectedIds: ReadonlySet<string>,
): Map<string, ClaudeScorerEntry> {
  const valid = new Map<string, ClaudeScorerEntry>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return valid;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return valid;
  }
  const shape = ScorerOutputShapeSchema.safeParse(raw);
  if (!shape.success) return valid;
  for (const candidate of shape.data.scores) {
    const parsed = ClaudeScorerEntrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (!expectedIds.has(entry.id) || valid.has(entry.id)) continue;
    valid.set(entry.id, entry);
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
    reason: entry.reason,
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
    // No allowedTools: the provider hard-disables the tool set, so feed
    // content has nothing to invoke even under prompt injection.
    const result = await provider.complete({ prompt: buildScorerPrompt(posts) });
    metrics?.recordLlmCall(llmResultToCallMetrics(provider.id, "scorer", startedAt, result));
    return parseScorerOutput(
      result.text,
      new Set(posts.map((post) => post.id)),
    );
  }

  return {
    async score(posts) {
      if (posts.length === 0) return [];
      const byId = await callOnce(posts);
      const missing = posts.filter((post) => !byId.has(post.id));
      if (missing.length > 0) {
        for (const [id, entry] of await callOnce(missing)) byId.set(id, entry);
      }
      return posts.map((post) => {
        const entry = byId.get(post.id);
        return entry ? toScoreEntry(entry) : unscoredEntry(post.id);
      });
    },
  };
}
