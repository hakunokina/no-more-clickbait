import { z } from "zod";

/**
 * Wire/storage schemas shared by the extension, the native host and the
 * desktop app. Feed content is untrusted input: everything crossing a
 * process boundary is parsed through these schemas.
 */

/** One playable rendition of a video/GIF. */
export const VideoVariantSchema = z.object({
  url: z.string().url(),
  /** Bits per second, when the platform reports it (GIFs often report 0). */
  bitrate: z.number().int().nonnegative().optional(),
});
export type VideoVariant = z.infer<typeof VideoVariantSchema>;

/** An image with its original pixel size, when known. */
export const SizedImageSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type SizedImage = z.infer<typeof SizedImageSchema>;

/**
 * Link preview data the platform attached to a link. Often absent (X
 * delivers most organic cards as a bare id); the renderer then falls
 * back to the link's own hostname.
 */
export const LinkCardSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  /** Display domain the card names (e.g. "news.example"). */
  domain: z.string().optional(),
  image: SizedImageSchema.optional(),
});
export type LinkCard = z.infer<typeof LinkCardSchema>;

export const PostMediaSchema = z.object({
  type: z.enum(["photo", "video", "gif", "link"]),
  /**
   * photo: the image; video/gif: the poster frame; link: the target
   * (expanded, not the shortener).
   */
  url: z.string().url(),
  altText: z.string().optional(),
  /** Original pixel size of the photo/video (aspect ratio before load). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** video: playback length. GIFs loop and carry none. */
  durationMs: z.number().int().nonnegative().optional(),
  /** video/gif: playable MP4 renditions, highest bitrate (best) first. */
  variants: z.array(VideoVariantSchema).optional(),
  /** link: the platform's preview card for this link, when delivered. */
  card: LinkCardSchema.optional(),
});
export type PostMedia = z.infer<typeof PostMediaSchema>;

export const PostSchema = z.object({
  /** Platform-native id, unique within `source`. */
  id: z.string().min(1),
  /** Connector that produced the post, e.g. "x-home-timeline". */
  source: z.string().min(1),
  authorHandle: z.string().min(1),
  authorName: z.string().optional(),
  /** Author's profile image (platform CDN), when delivered. */
  authorAvatarUrl: z.string().url().optional(),
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
      authorName: z.string().optional(),
      authorVerified: z.boolean().optional(),
      /** ISO 8601 timestamp of the quoted post. */
      publishedAt: z.string().datetime().optional(),
      /** The quoted post's media and links (same shape as `Post.media`). */
      media: z.array(PostMediaSchema).optional(),
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

/**
 * How Mode B keeps its X tab out of the user's sight. Chromium stops
 * rendering hidden pages and throttles their timers, so which surface
 * still lets X load more posts is measured, not assumed:
 * - `minimized-window`: a new window created minimized;
 * - `background-tab`: an inactive tab in the user's current window;
 * - `offscreen-window`: a small unfocused window pushed past the corner
 *   of the user's window (the OS may keep a sliver of it on screen).
 */
export const ModeBStrategySchema = z.enum([
  "minimized-window",
  "background-tab",
  "offscreen-window",
]);
export type ModeBStrategy = z.infer<typeof ModeBStrategySchema>;

interface IntegerSettingField {
  kind: "integer";
  min: number;
  max: number;
  default: number;
  /** Short UI label (Options page language: English). */
  label: string;
  /** One or two plain sentences: what it does, what raising/lowering it does. */
  description: string;
}

interface BooleanSettingField {
  kind: "boolean";
  default: boolean;
  label: string;
  description: string;
}

/**
 * The pipeline settings users tune on the Options page: bounds,
 * defaults and UI copy in one place. `SettingsSchema` is built from
 * this, so the form and the validation cannot drift apart. Scores are
 * on the 0-10 scale users see; the pipeline works on 0..1
 * (see `pipelineConfigFromSettings`).
 */
export const PIPELINE_SETTING_FIELDS = {
  timelineSize: {
    kind: "integer",
    min: 1,
    max: 100,
    default: 20,
    label: "Posts per finished timeline",
    description:
      "How many posts a finished timeline shows. If fewer posts pass the filters, " +
      "the timeline ends shorter instead of padding.",
  },
  maxClickbait: {
    kind: "integer",
    min: 1,
    max: 10,
    default: 7,
    label: "Clickbait limit (0–10)",
    description:
      "Posts whose clickbait score is below this pass. Lower it for a stricter " +
      "filter; raise it to let more sensational posts through.",
  },
  minReadValue: {
    kind: "integer",
    min: 0,
    max: 10,
    default: 2,
    label: "Minimum read value (0–10)",
    description:
      "Posts below this read value never appear. Raising it gives a shorter, " +
      "denser timeline; lowering it fills the timeline more easily.",
  },
  minReadForVerify: {
    kind: "integer",
    min: 0,
    max: 10,
    default: 4,
    label: "Verify posts from read value (0–10)",
    description:
      "Factual claims in posts with at least this read value are checked " +
      "against web sources. Lower it to check more posts (slower, uses more " +
      "LLM quota); raise it to check only the most valuable ones.",
  },
  maxVerifications: {
    kind: "integer",
    min: 1,
    max: 20,
    default: 20,
    label: "Most source checks per run",
    description:
      "Upper bound on web-source checks in one run, given to the best posts " +
      "first. Each check takes time and LLM quota.",
  },
  verifyEnabled: {
    kind: "boolean",
    default: true,
    label: "Check claims against sources",
    description:
      "Look up factual claims on the web before showing them. Posts whose " +
      "claims the sources contradict are left out. Turn off for faster, cheaper runs.",
  },
} as const satisfies Record<string, IntegerSettingField | BooleanSettingField>;

export type PipelineSettingKey = keyof typeof PIPELINE_SETTING_FIELDS;

/**
 * Every setting the extension syncs to the desktop (`settings-sync`):
 * the pipeline settings plus the collection target, with the same
 * bounds/defaults/UI copy shape.
 */
export const SYNCED_SETTING_FIELDS = {
  collectTarget: {
    kind: "integer",
    min: 1,
    max: 10_000,
    default: 250,
    label: "Posts to collect",
    description:
      "How many distinct posts to gather from your feed (as you scroll, or " +
      "automatically in Mode B) before the timeline is built. More posts give " +
      "the filters more to choose from but take longer to collect and judge.",
  },
  ...PIPELINE_SETTING_FIELDS,
} as const satisfies Record<string, IntegerSettingField | BooleanSettingField>;

export type SyncedSettingKey = keyof typeof SYNCED_SETTING_FIELDS;

function integerSetting(field: IntegerSettingField) {
  return z
    .number()
    .int()
    .min(field.min)
    .max(field.max)
    .default(field.default)
    .describe(field.description);
}

/**
 * The settings object itself (use for `.shape`/`.pick`). Parse stored
 * settings through `SettingsSchema`, which also migrates old ones.
 */
export const SettingsFieldsSchema = z.object({
  /** Mode B: auto-scroll a hidden tab to gather posts. OFF by default. */
  modeBEnabled: z.boolean().default(false),
  /**
   * @deprecated Use `collectTarget` (shared by Modes A and B). Kept so
   * settings saved before it still parse; it seeds `collectTarget` when
   * that is missing.
   */
  modeBTarget: z.number().int().min(1).max(1000).default(100),
  /** Distinct organic posts to collect (Mode A and Mode B) before a run. */
  collectTarget: integerSetting(SYNCED_SETTING_FIELDS.collectTarget),
  /** Developer choice of the hidden surface Mode B scrolls in. */
  modeBStrategy: ModeBStrategySchema.default("minimized-window"),
  /** How many posts a finished timeline shows before it ends (N). */
  timelineSize: integerSetting(PIPELINE_SETTING_FIELDS.timelineSize),
  /** Clickbait score (0-10) a post must stay BELOW to pass. */
  maxClickbait: integerSetting(PIPELINE_SETTING_FIELDS.maxClickbait),
  /** Read-value floor (0-10): posts below it are dropped. */
  minReadValue: integerSetting(PIPELINE_SETTING_FIELDS.minReadValue),
  /** Read value (0-10) a check-worthy post needs to be verified (owner: 4). */
  minReadForVerify: integerSetting(PIPELINE_SETTING_FIELDS.minReadForVerify),
  /** Most Verifier calls in one run. */
  maxVerifications: integerSetting(PIPELINE_SETTING_FIELDS.maxVerifications),
  /** Run the Verifier stage at all. */
  verifyEnabled: z
    .boolean()
    .default(PIPELINE_SETTING_FIELDS.verifyEnabled.default)
    .describe(PIPELINE_SETTING_FIELDS.verifyEnabled.description),
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

/** User settings shared between the extension options page and desktop. */
export const SettingsSchema = z.preprocess((raw) => {
  // Settings saved before `collectTarget` existed: Mode B's target was
  // the only collection target, so it carries over.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const stored = raw as Record<string, unknown>;
  return stored["collectTarget"] === undefined && stored["modeBTarget"] !== undefined
    ? { ...stored, collectTarget: stored["modeBTarget"] }
    : stored;
}, SettingsFieldsSchema);
export type Settings = z.infer<typeof SettingsSchema>;

/** The settings `settings-sync` carries to the desktop. */
export const SyncedSettingsSchema = SettingsFieldsSchema.pick({
  collectTarget: true,
  timelineSize: true,
  maxClickbait: true,
  minReadValue: true,
  minReadForVerify: true,
  maxVerifications: true,
  verifyEnabled: true,
});
export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>;

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

/** Why a Mode B run ended. */
export const ModeBStopReasonSchema = z.enum([
  "target-reached",
  "timeout",
  /** Several scroll steps in a row brought no new distinct post. */
  "stalled",
  "not-logged-in",
  "error-page",
  /** The tab left x.com/home (redirect or the user navigated it). */
  "navigated-away",
  "rate-limited",
  /** The page stopped answering scroll steps (frozen, crashed, not loaded). */
  "page-unresponsive",
  "tab-closed",
  "cancelled",
  /** Mode B or developer capture was toggled while the run was going. */
  "settings-changed",
  "permission-missing",
  "failed-to-open",
]);
export type ModeBStopReason = z.infer<typeof ModeBStopReasonSchema>;

/**
 * Counts and times of one Mode B run — never content. `counter` says
 * which side counted `uniquePostCount`: the host (developer capture on)
 * or the extension's own session counter; both run the same hard filter.
 */
export const ModeBRunSummarySchema = z.object({
  strategy: ModeBStrategySchema,
  counter: z.enum(["host", "extension"]),
  target: z.number().int().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  /** Scroll steps the page carried out. */
  scrollCount: z.number().int().nonnegative(),
  /** Steps after which the page's scroll position had actually moved. */
  scrollMovedCount: z.number().int().nonnegative(),
  /** Steps during which the page reported `document.hidden`. */
  hiddenStepCount: z.number().int().nonnegative(),
  /** HomeTimeline responses captured from the run's tab. */
  responseCount: z.number().int().nonnegative(),
  uniquePostCount: z.number().int().nonnegative(),
  stopReason: ModeBStopReasonSchema,
});
export type ModeBRunSummary = z.infer<typeof ModeBRunSummarySchema>;

/**
 * The extension finished collecting for a run (target reached, or the
 * collection stopped). Counts only — never content.
 */
export const CollectionCompleteSchema = z.object({
  type: z.literal("collection-complete"),
  /** Capture/collection session the counts belong to, when there is one. */
  sessionId: z.string().min(1).max(128).optional(),
  /** Distinct organic posts collected (hard-filtered: no ads, no repeats). */
  uniquePostCount: z.number().int().nonnegative(),
  responseCount: z.number().int().nonnegative(),
  /** A: the user's own scrolling; B: the hidden auto-scroll surface. */
  mode: z.enum(["A", "B"]),
  /** Why collection ended, e.g. "target-reached" or a ModeBStopReason. */
  reason: z.string().min(1).max(64),
});
export type CollectionComplete = z.infer<typeof CollectionCompleteSchema>;

/** Messages from the browser extension to the desktop app (via native host). */
export const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("post-batch"), batch: PostBatchSchema }),
  RawCaptureSchema,
  OversizedCaptureSchema,
  /** A finished Mode B run, recorded in the capture session's summary. */
  z.object({ type: z.literal("mode-b-run"), run: ModeBRunSummarySchema }),
  CollectionCompleteSchema,
  /** The user's synced settings, saved by the host for the desktop pipeline. */
  z.object({ type: z.literal("settings-sync"), settings: SyncedSettingsSchema }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/**
 * Messages from the desktop side to the extension: replies to the
 * messages above, plus unsolicited pushes (`start-collection`,
 * `link-status`).
 */
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
  z.object({ type: z.literal("mode-b-run-recorded") }),
  /** Ack of `collection-complete`. */
  z.object({ type: z.literal("collection-recorded") }),
  /** Ack of `settings-sync`: the host saved them. */
  z.object({ type: z.literal("settings-synced") }),
  /** Push: the desktop asks the extension to start collecting. */
  z.object({
    type: z.literal("start-collection"),
    /** Overrides the user's `collectTarget` for this collection. */
    target: z.number().int().min(1).max(10_000).optional(),
  }),
  /** Push: which ends of the bridge are currently connected. */
  z.object({
    type: z.literal("link-status"),
    desktopConnected: z.boolean(),
    extensionConnected: z.boolean(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type BridgeReply = z.infer<typeof BridgeReplySchema>;

/** UTF-8 byte length of a framed (JSON-serialised) bridge message. */
export function bridgeMessageByteLength(message: unknown): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}
