import { z } from "zod";
import { UiLangSchema, UiLanguageSchema, type UiLanguage } from "./i18n.js";

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
 * Feed sources beyond X. Each kind keeps its own schema and gets its own
 * renderer: X posts stay `Post` exactly as above (owner's decision: that
 * schema does not change), Instagram posts are `InstagramPost`, and
 * everything else (Reddit, custom URL rules) is a `GenericItem`.
 *
 * `FeedItem` is the union the pipeline and the TimelineDoc carry. It is
 * discriminated by `platform`, which only the new kinds must carry: an
 * item without one is an X `Post`. So every Post, every stored
 * result.json/timeline-doc.json and every X-only caller stays valid as
 * is — no wrapper, no migration. (`Post.source` cannot be the tag: it
 * already names the connector, e.g. "x-home-timeline".) Tell kinds apart
 * only through `platformOf` and the `isXPost`/`isInstagramPost`/
 * `isGenericItem` guards (feed-item.ts), never by probing fields.
 *
 * Not the same list as the capture side's `source` ("x" | "reddit" |
 * "instagram"): that names the site a raw response came from, this names
 * the item's shape — a Reddit post becomes a `generic` item with
 * `sourceLabel: "reddit"`.
 */
export const FeedPlatformSchema = z.enum(["x", "instagram", "generic"]);
export type FeedPlatform = z.infer<typeof FeedPlatformSchema>;

/** One image or video of an Instagram post (a carousel has several, in order). */
export const InstagramMediaSchema = z.object({
  type: z.enum(["image", "video"]),
  /** image: the image; video: the poster frame. */
  url: z.string().url(),
  /** video: a playable rendition. */
  videoUrl: z.string().url().optional(),
  /** video: every delivered rendition (`videoUrl` is the widest), widest first. */
  videoVariants: z
    .array(
      z.object({
        url: z.string().url(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  altText: z.string().optional(),
  /** Original pixel size (aspect ratio before load). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** video: playback length. */
  durationMs: z.number().int().nonnegative().optional(),
});
export type InstagramMedia = z.infer<typeof InstagramMediaSchema>;

/**
 * An Instagram feed post. Draft core: the field list follows the common
 * ground of what the feed delivers and may grow (additively) once the
 * capture research lands. Instagram has no quotes or reposts.
 */
export const InstagramPostSchema = z.object({
  platform: z.literal("instagram"),
  /** Platform-native media id, unique within Instagram. */
  id: z.string().min(1),
  /** Permalink of the post on instagram.com. */
  url: z.string().url(),
  authorHandle: z.string().min(1),
  authorName: z.string().optional(),
  authorAvatarUrl: z.string().url().optional(),
  authorVerified: z.boolean().optional(),
  /** The caption ("" when the post has none). */
  caption: z.string().default(""),
  /** post: one image/video; reel: a short video; carousel: several items. */
  kind: z.enum(["post", "reel", "carousel"]),
  media: z.array(InstagramMediaSchema).default([]),
  /** ISO 8601 timestamp of when the post was published. */
  publishedAt: z.string().datetime(),
  metrics: z
    .object({
      likes: z.number().nonnegative().optional(),
      comments: z.number().nonnegative().optional(),
      /** Reels: play count, when delivered. */
      views: z.number().nonnegative().optional(),
    })
    .optional(),
  /** True when Instagram labelled the post "Sponsored" (an ad). */
  promoted: z.boolean().default(false),
  /**
   * True when Instagram slipped the post in as "Suggested for you" (an
   * account the user does not follow), not a post of the followed feed.
   */
  suggested: z.boolean().optional(),
  /** Detected language of the caption, as `Post.lang` ("und" when undetermined). */
  lang: z.string().optional(),
  /** Co-authors of a collab post (the main author is `authorHandle`), in order. */
  coauthors: z
    .array(z.object({ handle: z.string().min(1), name: z.string().optional() }))
    .optional(),
  /** Tagged location's display name. */
  location: z.string().min(1).optional(),
  /**
   * Present when the post carries the "Paid partnership" label. Not an
   * ad (`promoted`): shown, with its label. `partner` is the brand when
   * delivered.
   */
  paidPartnership: z.object({ partner: z.string().min(1).optional() }).optional(),
});
export type InstagramPost = z.infer<typeof InstagramPostSchema>;

/**
 * What a generic item's content is, as its source states it (never
 * guessed from image proportions): `link` points elsewhere (an article,
 * a Reddit link post), `text` is a text post (Reddit self post), `image`
 * and `video` are posts whose media is the content itself.
 */
export const GenericItemKindSchema = z.enum(["link", "text", "image", "video"]);
export type GenericItemKind = z.infer<typeof GenericItemKindSchema>;

const HttpUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), "url must be http(s)");

/**
 * Anything that is neither X nor Instagram: a Reddit post, a page a
 * custom URL rule picked up. A link with a title is the common shape —
 * and the title is where clickbait lives.
 */
export const GenericItemSchema = z.object({
  platform: z.literal("generic"),
  /**
   * Stable within `sourceLabel` (e.g. the Reddit post id); when the
   * source has none, `genericItemIdFromUrl(url)`.
   */
  id: z.string().min(1),
  /** Where it came from: "reddit", "custom:<rule name>", … */
  sourceLabel: z.string().min(1),
  title: z.string().optional(),
  text: z.string().optional(),
  /** The item itself (the Reddit thread, the article). */
  url: HttpUrlSchema,
  /**
   * The external target when `url` is the item's own page on a
   * discussion site (a Reddit link post's article). Absent when `url`
   * already is the content (an article from a site rule or feed).
   */
  linkUrl: HttpUrlSchema.optional(),
  /** Display domain, e.g. "news.example" or "reddit.com". */
  domain: z.string().min(1),
  kind: GenericItemKindSchema.optional(),
  /** Detected/declared language, as `Post.lang` ("und" when undetermined). */
  lang: z.string().optional(),
  /** Label the source attached to the item (a Reddit flair). */
  flair: z.string().min(1).optional(),
  /** Icon of the site or community (favicon, subreddit icon). */
  siteIconUrl: HttpUrlSchema.optional(),
  author: z.string().optional(),
  /** The community it was posted in, e.g. "r/science". */
  community: z.string().optional(),
  /** ISO 8601 timestamp of when it was published, when known. */
  publishedAt: z.string().datetime().optional(),
  /**
   * Preview/thumbnail image, when delivered. `altText` only as the
   * source gives it; the title is no substitute.
   */
  image: SizedImageSchema.extend({ altText: z.string().optional() }).optional(),
  engagement: z
    .object({
      /** Net votes/points (Reddit scores can go below zero). */
      score: z.number().optional(),
      comments: z.number().nonnegative().optional(),
    })
    .optional(),
  /** True when the source marked it as an ad (e.g. Reddit "promoted"). */
  promoted: z.boolean().default(false),
});
export type GenericItem = z.infer<typeof GenericItemSchema>;

/** An X post inside the feed union: `Post` plus the optional tag. */
export const XFeedPostSchema = PostSchema.extend({ platform: z.literal("x").optional() });
export type XFeedPost = z.infer<typeof XFeedPostSchema>;

/** One feed item of any source; see `FeedPlatformSchema` for the tagging rule. */
export const FeedItemSchema = z.discriminatedUnion("platform", [
  XFeedPostSchema,
  InstagramPostSchema,
  GenericItemSchema,
]);
export type FeedItem = z.infer<typeof FeedItemSchema>;

/**
 * One post's judgement from the Scorer (single LLM call for the whole
 * batch). Scores are 0..1; thresholds live in code, not in the prompt.
 */
export const ScoreEntrySchema = z.object({
  /** The item's `feedItemKey` (for an X post: its id). */
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

/** A feed item that survived the whole pipeline, with its judgements attached. */
export const RankedPostSchema = z.object({
  post: FeedItemSchema,
  score: ScoreEntrySchema,
  verification: VerificationResultSchema.nullable(),
});
export type RankedPost = z.infer<typeof RankedPostSchema>;

/**
 * How Mode B keeps its X tab out of the user's sight. Chromium stops
 * rendering hidden pages and throttles their timers, so which surface
 * still lets X load more posts was measured, not assumed:
 * - `minimized-window`: a new window created minimized (the default);
 * - `offscreen-window`: a small unfocused window at the corner of the
 *   user's window (browsers keep at least half of it on screen);
 * - `background-tab`: an inactive tab in the user's current window.
 *   Retired — X stopped loading there in every trial; kept only so run
 *   summaries recorded with it still parse. Settings use `ModeBSurfaceSchema`.
 */
export const ModeBStrategySchema = z.enum([
  "minimized-window",
  "background-tab",
  "offscreen-window",
]);
export type ModeBStrategy = z.infer<typeof ModeBStrategySchema>;

/** The surfaces a Mode B run can still use. */
export const ModeBSurfaceSchema = ModeBStrategySchema.exclude(["background-tab"]);
export type ModeBSurface = z.infer<typeof ModeBSurfaceSchema>;

/**
 * How fast a Mode B run jumps between scroll steps: `normal` (the
 * default) or `fast`, twice as fast.
 */
export const ModeBPacingSchema = z.enum(["normal", "fast"]);
export type ModeBPacing = z.infer<typeof ModeBPacingSchema>;

/**
 * The feeds the extension collects by scrolling (each with its own tick
 * and its own `collectTarget`); custom sites are collected apart. In
 * Mode B they are scrolled one after the other, in this order.
 */
export const CollectSourceSchema = z.enum(["x", "instagram"]);
export type CollectSource = z.infer<typeof CollectSourceSchema>;

/** Paces of the pacing trial, read from older run summaries: `fixed` became `normal`. */
const LEGACY_MODE_B_PACING: Record<string, ModeBPacing | undefined> = {
  fixed: "normal",
  response: undefined,
};

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
    default: 50,
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
    label: "Clickbait limit (1–10)",
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
  collectFromX: {
    kind: "boolean",
    default: true,
    label: "Collect from X",
    description: "Collect posts from your X home timeline (x.com/home).",
  },
  collectFromInstagram: {
    kind: "boolean",
    default: false,
    label: "Collect from Instagram",
    description:
      "Collect posts from your Instagram home feed (instagram.com). Each source gathers its " +
      "own “Posts to collect”; in Mode B, Instagram is scrolled after X in the same window. " +
      "Ads are left out; posts without a caption are kept but not scored. Reload an " +
      "Instagram tab that was open when you turned this on.",
  },
  instagramFollowedOnly: {
    kind: "boolean",
    default: false,
    label: "Instagram: only accounts I follow",
    description:
      "Leave out the posts Instagram suggests from accounts you do not follow. They do not " +
      "count towards “Posts to collect”; the timeline's breakdown counts them apart. Off, " +
      "they are kept and marked “Suggested”.",
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
  /** Collect the X home timeline (ON by default). */
  collectFromX: z
    .boolean()
    .default(SYNCED_SETTING_FIELDS.collectFromX.default)
    .describe(SYNCED_SETTING_FIELDS.collectFromX.description),
  /** Collect the Instagram home feed (OFF by default). */
  collectFromInstagram: z
    .boolean()
    .default(SYNCED_SETTING_FIELDS.collectFromInstagram.default)
    .describe(SYNCED_SETTING_FIELDS.collectFromInstagram.description),
  /** Drop Instagram's suggestions (accounts not followed) instead of marking them. */
  instagramFollowedOnly: z
    .boolean()
    .default(SYNCED_SETTING_FIELDS.instagramFollowedOnly.default)
    .describe(SYNCED_SETTING_FIELDS.instagramFollowedOnly.description),
  /** The hidden surface Mode B scrolls in. */
  modeBStrategy: ModeBSurfaceSchema.default("minimized-window"),
  /** Mode B scroll pace; `fast` may be likelier to draw X's and Instagram's attention. */
  modeBPacing: ModeBPacingSchema.default("normal"),
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
   * @deprecated Use `collectTarget`. The old developer-capture target;
   * nothing reads it any more. Kept so old settings still parse; it
   * seeds `collectTarget` when neither that nor `modeBTarget` is set.
   */
  captureTarget: z.number().int().min(1).max(10_000).default(250),
  /** UI language of the desktop app and the timeline ("system": the OS's). */
  uiLanguage: UiLanguageSchema.default("system"),
});

/** User settings shared between the extension options page and desktop. */
export const SettingsSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  let stored = raw as Record<string, unknown>;
  // The retired background tab falls back to the default surface.
  if (stored["modeBStrategy"] === "background-tab") {
    stored = { ...stored, modeBStrategy: "minimized-window" };
  }
  // Settings saved before `collectTarget` existed: the old targets carry
  // over — Mode B's first, else the developer-capture one.
  if (stored["collectTarget"] !== undefined) return stored;
  const old = stored["modeBTarget"] ?? stored["captureTarget"];
  return old === undefined ? stored : { ...stored, collectTarget: old };
}, SettingsFieldsSchema);
export type Settings = z.infer<typeof SettingsSchema>;

/** The settings `settings-sync` carries to the desktop. */
export const SyncedSettingsSchema = SettingsFieldsSchema.pick({
  collectTarget: true,
  collectFromX: true,
  collectFromInstagram: true,
  instagramFollowedOnly: true,
  timelineSize: true,
  maxClickbait: true,
  minReadValue: true,
  minReadForVerify: true,
  maxVerifications: true,
  verifyEnabled: true,
});
export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>;

/** The feeds a collection scrolls, in their Mode B order (X first). */
export function enabledCollectSources(
  settings: Pick<Settings, "collectFromX" | "collectFromInstagram">,
): CollectSource[] {
  return CollectSourceSchema.options.filter((source) =>
    source === "x" ? settings.collectFromX : settings.collectFromInstagram,
  );
}

interface ChoiceSettingField<V extends string = string> {
  kind: "choice";
  default: V;
  options: readonly { value: V; label: string }[];
  label: string;
  description: string;
}

/**
 * The extension's collection switches the desktop app can change too,
 * with the same UI-copy shape as SYNCED_SETTING_FIELDS. Choice values
 * are the schema's enum values (a test keeps them in step).
 */
export const EXTENSION_SETTING_FIELDS = {
  modeBEnabled: {
    kind: "boolean",
    default: false,
    label: "Mode B: collect automatically in a hidden window",
    description:
      "Off by default, and risky: X and Instagram are opened out of sight and scrolled " +
      "automatically until enough posts are gathered. Automated browsing sits in a grey area " +
      "of X's and Instagram's terms of use and may put your accounts at risk. Turning it on needs the browser's “alarms” " +
      "permission, which only the extension's options page can ask for.",
  },
  modeBStrategy: {
    kind: "choice",
    default: "minimized-window",
    options: [
      { value: "minimized-window", label: "Minimized window" },
      { value: "offscreen-window", label: "Small window in the screen corner (visible)" },
    ],
    label: "Where Mode B collects",
    description:
      "Use the corner window if the minimized one stops loading posts. Browsers keep at " +
      "least half of a window on screen, so the corner window stays partly visible.",
  },
  modeBPacing: {
    kind: "choice",
    default: "normal",
    options: [
      { value: "normal", label: "Normal" },
      { value: "fast", label: "Fast" },
    ],
    label: "Mode B scroll pace",
    description:
      "Fast scrolls twice as quickly, but may be more likely to be noticed by X and Instagram.",
  },
  devCaptureEnabled: {
    kind: "boolean",
    default: false,
    label: "Developer capture: save raw timeline responses locally",
    description:
      "Off by default. Raw timeline responses are written outside the repo for debugging. " +
      "They are personal data — never share or commit them. Toggling it starts a new count.",
  },
} as const satisfies {
  modeBEnabled: BooleanSettingField;
  modeBStrategy: ChoiceSettingField<ModeBSurface>;
  modeBPacing: ChoiceSettingField<ModeBPacing>;
  devCaptureEnabled: BooleanSettingField;
};

export type ExtensionSettingKey = keyof typeof EXTENSION_SETTING_FIELDS;

/** UI preferences, with the same UI-copy shape (the extension carries them along). */
export const UI_SETTING_FIELDS = {
  uiLanguage: {
    kind: "choice",
    default: "system",
    options: [
      { value: "system", label: "System language" },
      { value: "en", label: "English" },
      { value: "tr", label: "Türkçe" },
    ],
    label: "Language",
    description:
      "The language of the desktop app and the timeline. System language follows Windows: " +
      "Turkish when Windows is in Turkish, English otherwise.",
  },
} as const satisfies { uiLanguage: ChoiceSettingField<UiLanguage> };

/** Every field the desktop Settings form shows, in its order. */
export const MANAGED_SETTING_FIELDS = {
  ...SYNCED_SETTING_FIELDS,
  ...EXTENSION_SETTING_FIELDS,
  ...UI_SETTING_FIELDS,
} as const;

export type ManagedSettingKey = keyof typeof MANAGED_SETTING_FIELDS;

/**
 * Every setting the desktop app shows and may change: the synced
 * pipeline settings plus the extension's collection switches. The
 * extension stays their owner (chrome.storage); the native host keeps
 * the desktop's copy in settings.json.
 */
export const ManagedSettingsSchema = SettingsFieldsSchema.pick({
  collectTarget: true,
  collectFromX: true,
  collectFromInstagram: true,
  instagramFollowedOnly: true,
  timelineSize: true,
  maxClickbait: true,
  minReadValue: true,
  minReadForVerify: true,
  maxVerifications: true,
  verifyEnabled: true,
  modeBEnabled: true,
  modeBStrategy: true,
  modeBPacing: true,
  devCaptureEnabled: true,
  uiLanguage: true,
});
export type ManagedSettings = z.infer<typeof ManagedSettingsSchema>;

export const ManagedSettingKeySchema = ManagedSettingsSchema.keyof();

/**
 * The managed settings missing from `raw` as a sender wrote it. An
 * extension built before a setting existed drops it unread (its schema
 * strips unknown keys), and parsing fills the gap with the default, so
 * the raw message is the only place the difference shows.
 */
export function missingManagedSettings(raw: unknown): (keyof ManagedSettings)[] {
  const record = typeof raw === "object" && raw !== null ? raw : {};
  return ManagedSettingKeySchema.options.filter((key) => !(key in record));
}

/**
 * When and where a settings set was last saved. Two copies (extension,
 * settings.json, a desktop change waiting for the browser) are
 * reconciled by it: the later save wins.
 */
export const SettingsStampSchema = z.object({
  updatedAt: z.string().datetime(),
  source: z.enum(["extension", "desktop"]),
});
export type SettingsStamp = z.infer<typeof SettingsStampSchema>;

/** Stamp of settings saved before stamps existed: older than any real save. */
export const UNSTAMPED: SettingsStamp = {
  updatedAt: "1970-01-01T00:00:00.000Z",
  source: "extension",
};

/** True when `a` was saved strictly later than `b` (ties are not newer). */
export function isNewerStamp(a: SettingsStamp, b: SettingsStamp): boolean {
  return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
}

/** Hard ceiling for one framed native-messaging message (extension + host). */
export const MAX_BRIDGE_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Which site a developer capture came from; absent means "x". */
export const CaptureSourceSchema = z.enum(["x", "reddit", "instagram"]);
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;

/** One raw timeline response body, forwarded verbatim for developer capture. */
export const RawCaptureSchema = z.object({
  type: z.literal("raw-capture"),
  source: CaptureSourceSchema.optional(),
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
  source: CaptureSourceSchema.optional(),
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
  /** The native host never answered (not installed or would not start). */
  "host-unreachable",
]);
export type ModeBStopReason = z.infer<typeof ModeBStopReasonSchema>;

/**
 * One feed's part of a Mode B run that scrolled several (X, then
 * Instagram in the same window): its own counts and why it ended.
 */
export const ModeBLegSchema = z.object({
  source: CollectSourceSchema,
  counter: z.enum(["host", "extension"]),
  target: z.number().int().min(1),
  uniquePostCount: z.number().int().nonnegative(),
  responseCount: z.number().int().nonnegative(),
  scrollCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  stopReason: ModeBStopReasonSchema,
});
export type ModeBLeg = z.infer<typeof ModeBLegSchema>;

/**
 * Counts and times of one Mode B run — never content. `counter` says
 * which side counted `uniquePostCount`: the host (developer capture on)
 * or the extension's own session counter; both run the same hard filter.
 * A run over several feeds reports its last feed here (`source`) and
 * every feed in `legs`.
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
  /** Fields below were added later; summaries stored before lack them. */
  pacing: z.preprocess(
    (value) =>
      typeof value === "string" && Object.hasOwn(LEGACY_MODE_B_PACING, value)
        ? LEGACY_MODE_B_PACING[value]
        : value,
    ModeBPacingSchema.optional(),
  ),
  /** Scroll steps per minute, from the first step to the end. */
  scrollsPerMinute: z.number().nonnegative().optional(),
  /** Steps after which a new response had arrived, the page's first one excluded. */
  stepsWithNewResponse: z.number().int().nonnegative().optional(),
  /** Mean time from a jump to the next response (the retired `response` pacing only). */
  avgResponseLatencyMs: z.number().int().nonnegative().optional(),
  /** The browser's error text behind the stop (e.g. why the window did not open). */
  error: z.string().max(500).optional(),
  /** The feed these counts are from (absent: X). */
  source: CollectSourceSchema.optional(),
  /** Every feed of a run that scrolled more than one, in order (absent: one feed). */
  legs: z.array(ModeBLegSchema).max(2).optional(),
});
export type ModeBRunSummary = z.infer<typeof ModeBRunSummarySchema>;

/**
 * The extension finished collecting for a run (target reached, or the
 * collection stopped). Counts only — never content.
 */
/** How one custom site's part of a collection went. */
export const SiteCollectOutcomeSchema = z.object({
  siteId: z.string().min(1).max(300),
  /** The rule's user-facing name (`SiteRule.name`); older extensions leave it out. */
  name: z.string().min(1).max(80).optional(),
  /** ok: items arrived; empty: the site answered with none; error/timeout/skipped: see `message`. */
  status: z.enum(["ok", "empty", "error", "timeout", "skipped"]),
  /** The method that produced the result ("rss", "static", "request", "page"). */
  method: z.string().min(1).max(16).optional(),
  itemCount: z.number().int().nonnegative(),
  message: z.string().max(300).optional(),
});
export type SiteCollectOutcome = z.infer<typeof SiteCollectOutcomeSchema>;

/**
 * One custom site's part of a collection while it runs: `waiting` (not
 * started), `collecting`, then its outcome's `status` with the items it
 * delivered (0 until it ends).
 */
export const SiteProgressSchema = SiteCollectOutcomeSchema.pick({
  siteId: true,
  name: true,
  itemCount: true,
}).extend({
  status: z.enum(["waiting", "collecting", ...SiteCollectOutcomeSchema.shape.status.options]),
});
export type SiteProgress = z.infer<typeof SiteProgressSchema>;

/**
 * How one scrolled feed's part of a collection went: its own distinct
 * posts against its own target, and why it stopped ("target-reached",
 * a ModeBStopReason, or the collection's own end such as "finished-early").
 */
export const CollectSourceOutcomeSchema = z.object({
  source: CollectSourceSchema,
  uniquePostCount: z.number().int().nonnegative(),
  reason: z.string().min(1).max(64),
  target: z.number().int().min(1).max(10_000).optional(),
});
export type CollectSourceOutcome = z.infer<typeof CollectSourceOutcomeSchema>;

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
  /** Distinct posts the collection was working towards. */
  target: z.number().int().min(1).max(10_000).optional(),
  /** Custom sites collected alongside X, one outcome each (a failed site never fails the rest). */
  sites: z.array(SiteCollectOutcomeSchema).max(100).optional(),
  /**
   * Each scrolled feed's outcome, in order, when the collection was not
   * X alone (absent: X only, whose counts are the ones above). The
   * top-level counts stay X's.
   */
  sources: z.array(CollectSourceOutcomeSchema).max(2).optional(),
});
export type CollectionComplete = z.infer<typeof CollectionCompleteSchema>;

/** A Mode B run's count so far (and its custom sites'), so the desktop app can show "x / N". */
export const CollectionProgressSchema = z.object({
  type: z.literal("collection-progress"),
  mode: z.literal("B"),
  uniquePostCount: z.number().int().nonnegative(),
  target: z.number().int().min(1).max(10_000),
  /** The feed being scrolled (absent: X). */
  source: CollectSourceSchema.optional(),
  /**
   * Every custom site of the collection as it stands now, in rule order
   * (absent: no site run, or an older extension). A whole list each time,
   * so a lost message is made up by the next.
   */
  sites: z.array(SiteProgressSchema).max(100).optional(),
});
export type CollectionProgress = z.infer<typeof CollectionProgressSchema>;

/**
 * Items from a source other than the X home timeline (a custom site
 * rule, `siteId` = its id). It joins the open collection session next
 * to the X `post-batch`es, but never touches the X counters (badge,
 * target, Mode B). The host stores it in the same session folder.
 */
export const FeedBatchSchema = z.object({
  /** The site rule's id (host + path, e.g. "news.example/world"). */
  siteId: z.string().min(1).max(300).optional(),
  /** ISO 8601 timestamp of when the batch was collected. */
  capturedAt: z.string().datetime(),
  items: z.array(FeedItemSchema).max(500),
});
export type FeedBatch = z.infer<typeof FeedBatchSchema>;

/** The extension's answer to the desktop's `start-collection` push. */
export const CollectionStartResultSchema = z.object({
  type: z.literal("collection-start-result"),
  outcome: z.enum([
    "started",
    /** Mode B is off: the user collects by browsing x.com/home (Mode A). */
    "mode-b-off",
    /** A Mode B run is already going. */
    "busy",
    /** Mode B lacks an optional permission it needs. */
    "permission-missing",
    /** X, Instagram and every custom site are off: nothing to collect. */
    "no-sources",
    "error",
  ]),
  /** Distinct posts the collection is working towards. */
  target: z.number().int().min(1).max(10_000).optional(),
  /** The feeds it scrolls, in order, when not X alone (`[]`: custom sites only). */
  sources: z.array(CollectSourceSchema).max(2).optional(),
});
export type CollectionStartResult = z.infer<typeof CollectionStartResultSchema>;

/**
 * The extension's answer to the desktop's `settings-push`: the settings
 * it now has (the pushed ones, or its own later save) for the host to
 * save and the desktop to show.
 */
export const SettingsPushResultSchema = z.object({
  type: z.literal("settings-push-result"),
  outcome: z.enum(["applied", "kept-newer"]),
  settings: ManagedSettingsSchema,
  stamp: SettingsStampSchema,
  /** Mode B was asked for but stays off: its optional permission is missing. */
  modeBPermissionMissing: z.boolean().optional(),
});
export type SettingsPushResult = z.infer<typeof SettingsPushResultSchema>;

/** Messages from the browser extension to the desktop app (via native host). */
export const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("post-batch"), batch: PostBatchSchema }),
  /** Non-X items (custom sites); acked with `feed-accepted`. */
  z.object({ type: z.literal("feed-batch"), batch: FeedBatchSchema }),
  RawCaptureSchema,
  OversizedCaptureSchema,
  /** A finished Mode B run, recorded in the capture session's summary. */
  z.object({ type: z.literal("mode-b-run"), run: ModeBRunSummarySchema }),
  CollectionCompleteSchema,
  CollectionStartResultSchema,
  CollectionProgressSchema,
  /**
   * The user's settings, saved by the host for the desktop (older
   * extensions send only the synced ones; the rest take defaults).
   * Without a stamp they count as older than any stamped save.
   */
  z.object({
    type: z.literal("settings-sync"),
    settings: ManagedSettingsSchema,
    stamp: SettingsStampSchema.optional(),
  }),
  SettingsPushResultSchema,
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/**
 * Messages from the desktop side to the extension: replies to the
 * messages above, plus unsolicited pushes (`start-collection`,
 * `stop-collection`, `link-status`).
 */
export const BridgeReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("batch-accepted"), postCount: z.number().int().nonnegative() }),
  /** Ack of `feed-batch`: how many items were stored. */
  z.object({
    type: z.literal("feed-accepted"),
    siteId: z.string().min(1).max(300).optional(),
    itemCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("capture-accepted"),
    /** The capture's source; `stats` are that source's session counts. */
    source: CaptureSourceSchema.optional(),
    sequence: z.number().int().positive(),
    stats: CaptureStatsSchema,
  }),
  z.object({
    type: z.literal("capture-rejected"),
    source: CaptureSourceSchema.optional(),
    message: z.string(),
    stats: CaptureStatsSchema,
  }),
  z.object({ type: z.literal("mode-b-run-recorded") }),
  /** Ack of `collection-complete`, `collection-start-result` and `collection-progress`. */
  z.object({ type: z.literal("collection-recorded") }),
  /** Ack of `settings-sync` / `settings-push-result`: the host handled them. */
  z.object({ type: z.literal("settings-synced") }),
  /**
   * Push: settings changed in the desktop app. The extension applies
   * them unless its own copy is newer, then answers `settings-push-result`.
   */
  z.object({
    type: z.literal("settings-push"),
    settings: ManagedSettingsSchema,
    stamp: SettingsStampSchema,
  }),
  /** Push: the desktop asks the extension to start collecting. */
  z.object({
    type: z.literal("start-collection"),
    /** Overrides the user's `collectTarget` for this collection. */
    target: z.number().int().min(1).max(10_000).optional(),
  }),
  /** Push: the desktop cancels the running collection (it ends as `cancelled`). */
  z.object({ type: z.literal("stop-collection") }),
  /**
   * Push: the language the desktop app shows — its `uiLanguage`, with
   * "system" resolved against the OS. An extension set to "system"
   * follows it rather than the browser's language.
   */
  z.object({ type: z.literal("ui-lang"), lang: UiLangSchema }),
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
