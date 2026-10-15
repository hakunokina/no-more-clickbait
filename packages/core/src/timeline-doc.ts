import { z } from "zod";
import { isInstagramPost, isXPost } from "./feed-item.js";
import { FunnelCountsSchema, type FunnelCounts } from "./metrics.js";
import {
  FeedItemSchema,
  ScoreEntrySchema,
  VerificationResultSchema,
  type FeedItem,
  type RankedPost,
  type XFeedPost,
} from "./schemas.js";

/**
 * TimelineDoc: the one document the timeline renderer consumes. It is
 * presentation-ready but content-free of judgement logic: ordering,
 * cut-offs and verification already happened in the pipeline; the
 * renderer only lays it out. Feed content inside stays untrusted — the
 * renderer escapes every string and allow-lists every URL.
 *
 * A card's `post` is a `FeedItem`: an X post (no `platform`, exactly as
 * before — documents written before other sources existed stay valid),
 * an Instagram post or a generic item. Each kind has its own renderer;
 * pick it with `platformOf(card.post)`.
 */

export const TIMELINE_DOC_VERSION = 1;

/** A 0..1 score as a word level for the "Why is this here?" panel. */
export const ScoreLevelSchema = z.enum(["very-low", "low", "medium", "high", "very-high"]);
export type ScoreLevel = z.infer<typeof ScoreLevelSchema>;

/**
 * A 0..1 score on the Settings' 0-10 scale, rounded DOWN: the pipeline
 * keeps clickbait < maxClickbait/10 and read value ≥ minReadValue/10, so
 * a shown post reads "6 / 10" under a "max 7" setting, never "7 / 10".
 * The epsilon absorbs float error (0.7 * 10 = 6.999…).
 */
export function scoreOutOfTen(score: number): number {
  return Math.min(10, Math.max(0, Math.floor(score * 10 + 1e-9)));
}

/** 0-1 → very-low, 2-3 → low, 4-5 → medium, 6-7 → high, 8-10 → very-high (scoreOutOfTen). */
export function scoreLevel(score: number): ScoreLevel {
  const tenths = scoreOutOfTen(score);
  if (tenths <= 1) return "very-low";
  if (tenths <= 3) return "low";
  if (tenths <= 5) return "medium";
  if (tenths <= 7) return "high";
  return "very-high";
}

export const TimelineCardSchema = z.object({
  /** 1-based position; the order IS the read-value ranking. */
  rank: z.number().int().positive(),
  post: FeedItemSchema,
  score: ScoreEntrySchema,
  levels: z.object({ readValue: ScoreLevelSchema, clickbait: ScoreLevelSchema }),
  /**
   * null: not verified (no check-worthy claim, below the verify floor,
   * over budget, or verification off). Never `false_or_disputed`:
   * contradicted posts leave the timeline and only count in the funnel.
   */
  verification: VerificationResultSchema.nullable().refine(
    (verification) => verification?.status !== "false_or_disputed",
    "contradicted posts are not shown; they only count in the funnel",
  ),
});
export type TimelineCard = z.infer<typeof TimelineCardSchema>;

/** A card holding an X post (the X renderer's input). */
export type XTimelineCard = TimelineCard & { post: XFeedPost };

export function isXCard(card: TimelineCard): card is XTimelineCard {
  return isXPost(card.post);
}

export const TimelineStatusSchema = z.discriminatedUnion("state", [
  /** N posts shown. */
  z.object({ state: z.literal("ok") }),
  /** Fewer than N passed the rules; the floor was not lowered to pad. */
  z.object({ state: z.literal("short") }),
  /** No post passed; the "Done" screen with the tally is the result. */
  z.object({ state: z.literal("empty") }),
  z.object({
    state: z.literal("error"),
    /** Plain-language cause, for the reader. */
    reason: z.string().min(1),
    /** Technical detail for the collapsible section (no secrets, no feed content). */
    detail: z.string().optional(),
  }),
]);
export type TimelineStatus = z.infer<typeof TimelineStatusSchema>;

export const TimelineDocSchema = z
  .object({
    version: z.literal(TIMELINE_DOC_VERSION),
    header: z.object({
      /** ISO 8601 time the document was produced (the timeline's date). */
      generatedAt: z.string().datetime(),
      /** ISO 8601 time of the last feed capture the run used, when known. */
      capturedAt: z.string().datetime().optional(),
      /** N: how many posts the user asked for. */
      timelineSize: z.number().int().positive(),
      /** Words in the shown posts (own + quoted text), for a reading-time estimate. */
      wordCount: z.number().int().nonnegative(),
    }),
    cards: z.array(TimelineCardSchema),
    /** null only for an error before the pipeline produced counts. */
    funnel: FunnelCountsSchema.nullable(),
    status: TimelineStatusSchema,
  })
  .superRefine((doc, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    doc.cards.forEach((card, index) => {
      if (card.rank !== index + 1) issue(`card ${index} has rank ${card.rank}`);
    });
    const shown = doc.cards.length;
    if (doc.status.state === "error") return;
    if (!doc.funnel) return issue("only an error doc may omit the funnel");
    if (doc.funnel.shown !== shown) issue("funnel.shown must equal the card count");
    const expected = shown === 0 ? "empty" : shown < doc.header.timelineSize ? "short" : "ok";
    if (doc.status.state !== expected) issue(`status must be "${expected}" for ${shown} cards`);
  });
export type TimelineDoc = z.infer<typeof TimelineDocSchema>;

/** What `toTimelineDoc` needs; a `CaptureRunReport` satisfies it. */
export interface TimelineDocSource {
  selected: readonly RankedPost[];
  funnel: FunnelCounts;
  settings: { timelineSize: number };
  collection?: { lastCapturedAt: string };
}

function countWords(text: string | undefined): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Words a reader goes through for one item: an X post's own text plus
 * the quote, an Instagram caption, a generic item's title and text.
 */
export function postWordCount(post: FeedItem): number {
  if (isXPost(post)) return countWords(post.text) + countWords(post.quoted?.text);
  if (isInstagramPost(post)) return countWords(post.caption);
  return countWords(post.title) + countWords(post.text);
}

/** A finished run → the renderer's document (validated; throws if inconsistent). */
export function toTimelineDoc(source: TimelineDocSource, now: Date = new Date()): TimelineDoc {
  const cards: TimelineCard[] = source.selected.map(({ post, score, verification }, index) => ({
    rank: index + 1,
    post,
    score,
    levels: {
      readValue: scoreLevel(score.readWorthinessScore),
      clickbait: scoreLevel(score.clickbaitScore),
    },
    verification,
  }));
  const timelineSize = source.settings.timelineSize;
  const state = cards.length === 0 ? "empty" : cards.length < timelineSize ? "short" : "ok";
  return TimelineDocSchema.parse({
    version: TIMELINE_DOC_VERSION,
    header: {
      generatedAt: now.toISOString(),
      ...(source.collection ? { capturedAt: source.collection.lastCapturedAt } : {}),
      timelineSize,
      wordCount: cards.reduce((sum, card) => sum + postWordCount(card.post), 0),
    },
    cards,
    funnel: source.funnel,
    status: { state },
  });
}

export interface TimelineErrorInput {
  /** Plain-language cause for the reader. */
  reason: string;
  detail?: string;
  timelineSize: number;
  /** Counts so far, when the run got that far. */
  funnel?: FunnelCounts;
  capturedAt?: string;
}

/** A run that failed → an error document (no cards). */
export function errorTimelineDoc(
  input: TimelineErrorInput,
  now: Date = new Date(),
): TimelineDoc {
  return TimelineDocSchema.parse({
    version: TIMELINE_DOC_VERSION,
    header: {
      generatedAt: now.toISOString(),
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      timelineSize: input.timelineSize,
      wordCount: 0,
    },
    cards: [],
    funnel: input.funnel ?? null,
    status: {
      state: "error",
      reason: input.reason,
      ...(input.detail ? { detail: input.detail } : {}),
    },
  });
}
