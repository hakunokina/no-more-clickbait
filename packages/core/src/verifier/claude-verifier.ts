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
import { feedItemKey } from "../feed-item.js";
import type { RunMetricsCollector } from "../metrics.js";
import type { Verifier } from "../pipeline.js";
import {
  MAX_VERIFICATION_SUMMARY_WORDS,
  VerificationStatusSchema,
  type FeedItem,
  type VerificationResult,
  type VerificationSource,
} from "../schemas.js";
import {
  buildVerifierPrompt,
  VERIFIER_REPLY_JSON_SCHEMA,
  VERIFIER_SYSTEM_PROMPT,
} from "./verifier-prompt.js";

/**
 * Phase 1 Verifier: one `claude` CLI call per claim, web tools only.
 * Which claims are worth a call is decided in code (pipeline: check-
 * worthy and read value above a floor), not by the model; the model
 * searches and returns a status, a confidence, a short Turkish summary
 * and sources.
 * Code, not the model, enforces the rules that keep the UI honest:
 * `verified`/`false_or_disputed` without a usable source falls back to
 * `unverifiable`, the summary is capped, source URLs must be http(s).
 *
 * Failure handling: a CliRunError (CLI exit, timeout, budget cap,
 * unparseable output) or a reply that fails the schema becomes an
 * `unverifiable` result marked `failed`, recorded in the run metrics
 * as a failed call. CLI missing / not logged in and unexpected errors
 * propagate — they are not a judgement about one claim. When the
 * failed CLI run still reported its cost (e.g. the budget cap hit),
 * that cost is recorded with the failed call.
 */

/** Mirrors VERIFIER_REPLY_JSON_SCHEMA; this is the check we trust. */
export const VerifierReplySchema = z.object({
  status: VerificationStatusSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })),
});
export type VerifierReply = z.infer<typeof VerifierReplySchema>;

const MAX_SOURCES = 5;
const MAX_TITLE_CHARS = 200;

const FAILED_SUMMARY = "Doğrulanamadı: doğrulama çağrısı sonuç vermedi.";
const NO_SOURCE_SUMMARY = "Doğrulanamadı: karar için kaynak gösterilmedi.";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most MAX_VERIFICATION_SUMMARY_WORDS words; a cut gets "…". */
export function capSummary(text: string): string {
  const words = oneLine(text).split(" ").filter(Boolean);
  if (words.length <= MAX_VERIFICATION_SUMMARY_WORDS) return words.join(" ");
  return `${words.slice(0, MAX_VERIFICATION_SUMMARY_WORDS).join(" ")}…`;
}

/** http(s) URLs only, deduplicated, titled (hostname when untitled), capped. */
function cleanSources(raw: VerifierReply["sources"]): VerificationSource[] {
  const seen = new Set<string>();
  const out: VerificationSource[] = [];
  for (const source of raw) {
    let url: URL;
    try {
      url = new URL(source.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = oneLine(source.title).slice(0, MAX_TITLE_CHARS) || url.hostname;
    out.push({ url: url.href, title });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** Applies the code-side rules to a schema-valid reply. */
export function toVerificationResult(
  postId: string,
  claim: string,
  reply: VerifierReply,
): VerificationResult {
  const sources = cleanSources(reply.sources);
  if (
    (reply.status === "verified" || reply.status === "false_or_disputed") &&
    sources.length === 0
  ) {
    // The model's confidence was in the verdict it gave, not in this
    // fallback: carrying it over would read as a sure "unverifiable".
    return {
      postId,
      claim,
      status: "unverifiable",
      confidence: 0,
      summary: NO_SOURCE_SUMMARY,
      sources: [],
    };
  }
  return {
    postId,
    claim,
    status: reply.status,
    confidence: reply.confidence,
    summary: capSummary(reply.summary),
    sources,
  };
}

function failedResult(postId: string, claim: string): VerificationResult {
  return {
    postId,
    claim,
    status: "unverifiable",
    confidence: 0,
    summary: FAILED_SUMMARY,
    sources: [],
    failed: true,
  };
}

/**
 * The `claude` CLI settings the Verifier is measured with. Model
 * pinned and user settings isolated for the same reasons as the
 * Scorer (see CLAUDE_SCORER_CLI_DEFAULTS). Effort "low": on 3
 * synthetic claims (one true, one false, one unverifiable) low and
 * medium gave the same three statuses and near-identical confidence,
 * call time (~12-14 s) and searches; low spent fewer thinking tokens
 * (1660 vs 2355) and output tokens (5485 vs 5982) — claude 2.1.300.
 * The CLI runs WebSearch on a helper model (haiku), ~12k input tokens
 * per search, so searches, not the main model's effort, dominate cost.
 * The timeout and budget cap bound one claim: a call that runs away
 * (search loop, huge fetched pages) fails into `unverifiable` instead
 * of stalling the run or spending without limit.
 */
export const CLAUDE_VERIFIER_CLI_DEFAULTS = {
  model: "claude-opus-5-5",
  effort: "low",
  isolateUserSettings: true,
  timeoutMs: 3 * 60 * 1000,
  maxBudgetUsd: 0.5,
} as const satisfies ClaudeCliOptions;

/** The `claude` CLI provider with the Verifier's pinned settings. */
export function createClaudeVerifierProvider(options: ClaudeCliOptions = {}): CliLlmProvider {
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as ClaudeCliOptions;
  return createClaudeCliProvider({ ...CLAUDE_VERIFIER_CLI_DEFAULTS, ...defined });
}

/** The only tools a verification call gets. */
export const VERIFIER_TOOLS = ["WebSearch", "WebFetch"] as const;

export interface ClaudeVerifierOptions {
  provider: LlmProvider;
  /** Metrics sink shared with the pipeline run (stage "verifier"). */
  metrics?: RunMetricsCollector;
  /** Clock for the prompt's "today" (tests pin it). */
  now?: () => Date;
}

export function createClaudeVerifier(options: ClaudeVerifierOptions): Verifier {
  const { provider, metrics } = options;
  const now = options.now ?? (() => new Date());

  return {
    async verify(post: FeedItem, claim: string): Promise<VerificationResult> {
      const postId = feedItemKey(post);
      const startedAt = new Date().toISOString();
      const started = Date.now();
      let result: LlmResult;
      try {
        result = await provider.complete({
          systemPrompt: VERIFIER_SYSTEM_PROMPT,
          prompt: buildVerifierPrompt(post, claim, now().toISOString().slice(0, 10)),
          allowedTools: VERIFIER_TOOLS,
          jsonSchema: VERIFIER_REPLY_JSON_SCHEMA,
        });
      } catch (error) {
        metrics?.recordLlmCall({
          providerId: provider.id,
          stage: "verifier",
          startedAt,
          durationMs: Date.now() - started,
          postId,
          postCount: 1,
          failed: true,
          // A budget-capped run still reports what it spent.
          ...(error instanceof CliRunError && error.costUsd !== undefined
            ? { costUsd: error.costUsd }
            : {}),
        });
        if (error instanceof CliRunError) return failedResult(postId, claim);
        throw error;
      }
      const reply = parseReply(result.text);
      metrics?.recordLlmCall({
        ...llmResultToCallMetrics(provider.id, "verifier", startedAt, result),
        postId,
        postCount: 1,
        ...(reply ? {} : { failed: true }),
      });
      return reply ? toVerificationResult(postId, claim, reply) : failedResult(postId, claim);
    },
  };
}

/** The reply object, or undefined when it is not schema-valid JSON. */
export function parseReply(text: string): VerifierReply | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = VerifierReplySchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
