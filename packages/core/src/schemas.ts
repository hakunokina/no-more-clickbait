import { z } from "zod";

/**
 * Wire/storage schemas shared by the extension, the native host and the
 * desktop app. Feed content is untrusted input: everything crossing a
 * process boundary is parsed through these schemas.
 */

export const PostMediaSchema = z.object({
  type: z.enum(["photo", "video", "gif", "link"]),
  url: z.string().url(),
  altText: z.string().optional(),
});
export type PostMedia = z.infer<typeof PostMediaSchema>;

export const PostSchema = z.object({
  /** Platform-native id, unique within `source`. */
  id: z.string().min(1),
  /** Connector that produced the post, e.g. "x-home-timeline". */
  source: z.string().min(1),
  authorHandle: z.string().min(1),
  authorName: z.string().optional(),
  text: z.string(),
  /** Canonical URL of the post on its platform. */
  url: z.string().url(),
  /** ISO 8601 timestamp of when the post was published. */
  publishedAt: z.string().datetime(),
  media: z.array(PostMediaSchema).default([]),
  metrics: z
    .object({
      likes: z.number().nonnegative().optional(),
      reposts: z.number().nonnegative().optional(),
      replies: z.number().nonnegative().optional(),
      quotes: z.number().nonnegative().optional(),
      views: z.number().nonnegative().optional(),
    })
    .optional(),
  /** True when the platform marked the post as an ad/promotion. */
  promoted: z.boolean().default(false),
  /** Platform verification badge of the author, when the platform reports one. */
  authorVerified: z.boolean().optional(),
  /** Platform-detected language code, e.g. "en" ("und" when undetermined). */
  lang: z.string().optional(),
  /**
   * Set when this post reached the feed as someone's repost: the post
   * itself (id, author, text, metrics) is the ORIGINAL; this is the
   * handle of the account that reposted it.
   */
  repostedBy: z.string().min(1).optional(),
  /** The post this one quotes, when the platform delivered it. */
  quoted: z
    .object({
      id: z.string().min(1),
      authorHandle: z.string().min(1),
      text: z.string(),
    })
    .optional(),
  /**
   * True when the post has no text of its own (nor quoted text) and
   * only media: it cannot be judged from text. The hard filter keeps it
   * but counts it; downstream stages decide how to present it.
   */
  mediaOnly: z.boolean().optional(),
});
export type Post = z.infer<typeof PostSchema>;

/** A batch of posts captured by a connector in one pass. */
export const PostBatchSchema = z.object({
  source: z.string().min(1),
  /** ISO 8601 timestamp of when the batch was captured. */
  capturedAt: z.string().datetime(),
  posts: z.array(PostSchema),
});
export type PostBatch = z.infer<typeof PostBatchSchema>;

/**
 * One post's judgement from the Scorer (single LLM call for the whole
 * batch). Scores are 0..1; thresholds live in code, not in the prompt.
 */
export const ScoreEntrySchema = z.object({
  postId: z.string().min(1),
  /** 0 = straight reporting, 1 = pure clickbait. */
  clickbaitScore: z.number().min(0).max(1),
  /** 0 = not worth the reader's time, 1 = highly worth reading. */
  readWorthinessScore: z.number().min(0).max(1),
  /** True when the post carries a factual claim worth verifying. */
  checkWorthy: z.boolean().optional(),
  /** The single most check-worthy factual claim, if any. */
  checkWorthyClaim: z.string().min(1).nullable(),
  /**
   * Short human-readable justification of the scores; null when the
   * Scorer gave none (it is only asked for on suspicious/check-worthy posts).
   */
  reason: z.string().nullable().optional(),
  /**
   * True when the Scorer could not obtain a valid score for this post
   * (the LLM never returned one). Scores are then conservative
   * placeholders (clickbait 1, read-worthiness 0) so threshold selectors
   * drop the post, but the entry stays visible instead of vanishing.
   */
  scoringFailed: z.boolean().optional(),
});
export type ScoreEntry = z.infer<typeof ScoreEntrySchema>;

export const VerificationStatusSchema = z.enum([
  /** Sources back the claim. */
  "verified",
  /** Sources contradict or dispute the claim (wording stays cautious). */
  "false_or_disputed",
  // The UI must never overclaim: absence of evidence is its own status.
  "unverifiable",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationSourceSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => /^https?:\/\//i.test(url), "source url must be http(s)"),
  title: z.string(),
});
export type VerificationSource = z.infer<typeof VerificationSourceSchema>;

/** Most words a verification summary may carry (it is a badge caption). */
export const MAX_VERIFICATION_SUMMARY_WORDS = 25;

export const VerificationResultSchema = z
  .object({
    postId: z.string().min(1),
    claim: z.string().min(1),
    status: VerificationStatusSchema,
    /** 0..1: how sure the Verifier is of `status`. */
    confidence: z.number().min(0).max(1),
    /** Short Turkish explanation, at most MAX_VERIFICATION_SUMMARY_WORDS words. */
    summary: z
      .string()
      .refine(
        (text) => text.trim().split(/\s+/).length <= MAX_VERIFICATION_SUMMARY_WORDS,
        `summary must be at most ${MAX_VERIFICATION_SUMMARY_WORDS} words`,
      ),
    sources: z.array(VerificationSourceSchema),
    /**
     * True when no judgement was obtained (CLI error, timeout, unusable
     * reply): the status is then the `unverifiable` fallback.
     */
    failed: z.boolean().optional(),
  })
  .superRefine((result, ctx) => {
    if (
      (result.status === "verified" || result.status === "false_or_disputed") &&
      result.sources.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: `${result.status} requires at least one source`,
      });
    }
  });
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/** A post that survived the whole pipeline, with its judgements attached. */
export const RankedPostSchema = z.object({
  post: PostSchema,
  score: ScoreEntrySchema,
  verification: VerificationResultSchema.nullable(),
});
export type RankedPost = z.infer<typeof RankedPostSchema>;

/** User settings shared between the extension options page and desktop. */
export const SettingsSchema = z.object({
  /** Mode B: auto-scroll a hidden tab to gather posts. OFF by default. */
  modeBEnabled: z.boolean().default(false),
  /** How many posts a finished timeline shows before it ends. */
  timelineSize: z.number().int().min(1).max(100).default(20),
  /**
   * Developer capture: forward raw HomeTimeline response bodies to the
   * native host for local inspection. OFF by default. Raw captures are
   * personal data; they are written outside the repo and must never be
   * shared or committed.
   */
  devCaptureEnabled: z.boolean().default(false),
  /**
   * Developer-capture target: the extension badges/notifies once this
   * many (roughly counted) posts were captured. Capture does not stop.
   */
  captureTarget: z.number().int().min(1).max(10_000).default(250),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Hard ceiling for one framed native-messaging message (extension + host). */
export const MAX_BRIDGE_MESSAGE_BYTES = 32 * 1024 * 1024;

/** One raw timeline response body, forwarded verbatim for developer capture. */
export const RawCaptureSchema = z.object({
  type: z.literal("raw-capture"),
  /** Which GraphQL operation produced it, e.g. "HomeTimeline". */
  operation: z.string().min(1).max(64),
  /** ISO 8601 time the response was captured in the browser. */
  capturedAt: z.string().datetime(),
  /** Raw response body text. Untrusted; stored as-is, never into the repo. */
  bodyText: z.string(),
});
export type RawCapture = z.infer<typeof RawCaptureSchema>;

/** Reports a response the extension refused to send (frame ceiling). */
export const OversizedCaptureSchema = z.object({
  type: z.literal("capture-oversized"),
  operation: z.string().min(1).max(64),
  capturedAt: z.string().datetime(),
  /** Framed byte length that exceeded MAX_BRIDGE_MESSAGE_BYTES. */
  byteLength: z.number().int().positive(),
});
export type OversizedCapture = z.infer<typeof OversizedCaptureSchema>;

/** Cumulative per-session capture counts the host reports back. */
export const CaptureStatsSchema = z.object({
  responseCount: z.number().int().nonnegative(),
  /** Rough: `tweet-` entries summed per response, repeats included. */
  postCount: z.number().int().nonnegative(),
  /**
   * Distinct organic posts this session (parsed Posts through the hard
   * filter: no ads, no repeats across responses). The capture target
   * is measured against this.
   */
  uniquePostCount: z.number().int().nonnegative(),
  promotedCount: z.number().int().nonnegative(),
  oversizedCount: z.number().int().nonnegative(),
});
export type CaptureStats = z.infer<typeof CaptureStatsSchema>;

/** Messages from the browser extension to the desktop app (via native host). */
export const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("post-batch"), batch: PostBatchSchema }),
  RawCaptureSchema,
  OversizedCaptureSchema,
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/** Replies from the desktop side back to the extension. */
export const BridgeReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("batch-accepted"), postCount: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("capture-accepted"),
    sequence: z.number().int().positive(),
    stats: CaptureStatsSchema,
  }),
  z.object({
    type: z.literal("capture-rejected"),
    message: z.string(),
    stats: CaptureStatsSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type BridgeReply = z.infer<typeof BridgeReplySchema>;

/** UTF-8 byte length of a framed (JSON-serialised) bridge message. */
export function bridgeMessageByteLength(message: unknown): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}
