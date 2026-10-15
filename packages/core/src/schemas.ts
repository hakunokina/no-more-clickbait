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
      views: z.number().nonnegative().optional(),
    })
    .optional(),
  /** True when the platform marked the post as an ad/promotion. */
  promoted: z.boolean().default(false),
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
  /** Short human-readable justification of the scores. */
  reason: z.string().optional(),
  /**
   * True when the Scorer could not obtain a valid score for this post
   * (the LLM never returned one). Scores are then conservative
   * placeholders (clickbait 1, read-worthiness 0) so threshold selectors
   * drop the post, but the entry stays visible instead of vanishing.
   */
  scoringFailed: z.boolean().optional(),
});
export type ScoreEntry = z.infer<typeof ScoreEntrySchema>;

export const VerdictSchema = z.enum([
  "supported",
  "contradicted",
  // The UI must never overclaim: absence of evidence is its own verdict.
  "unverifiable",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerificationResultSchema = z.object({
  postId: z.string().min(1),
  claim: z.string().min(1),
  verdict: VerdictSchema,
  /** Short human-readable explanation of the verdict. */
  rationale: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string().url() })),
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
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Messages from the browser extension to the desktop app (via native host). */
export const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("post-batch"), batch: PostBatchSchema }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/** Replies from the desktop side back to the extension. */
export const BridgeReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("batch-accepted"), postCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type BridgeReply = z.infer<typeof BridgeReplySchema>;
