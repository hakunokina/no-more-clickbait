import {
  PostSchema,
  type LinkCard,
  type Post,
  type PostMedia,
  type SizedImage,
  type VideoVariant,
} from "../schemas.js";

/**
 * X (Twitter) HomeTimeline GraphQL response → core Posts.
 *
 * The response shape is undocumented and drifts, so every field is read
 * defensively: an entry the parser does not understand is skipped and
 * counted, never thrown on. Field paths are documented in
 * docs/x-home-timeline.md. Feed content is untrusted; this module only
 * copies it into schema-validated Posts.
 *
 * Duplicates (overlapping responses, the same original reposted twice)
 * and promoted posts are NOT removed here — that is the hard filter's
 * job, so its counters see them. Only entries that can never become a
 * Post (cursors, suggestion modules such as who-to-follow, withheld or
 * deleted tweets) are skipped here.
 */

export const X_HOME_TIMELINE_SOURCE = "x-home-timeline";

export type HomeTimelineSkipReason =
  /** Pagination cursor entries. */
  | "cursor"
  /** Non-conversation modules: who-to-follow and other suggestions. */
  | "suggestion-module"
  /** Single items that are not tweets (users, prompts, messages…). */
  | "non-tweet-item"
  /** Tombstones and withheld/unavailable tweet results. */
  | "unavailable"
  /** A tweet result missing required fields (id, author, date…). */
  | "invalid-tweet"
  /** An entry of a shape this parser does not know. */
  | "unknown-entry"
  /** An instruction type this parser does not know. */
  | "unknown-instruction";

export interface HomeTimelineParseStats {
  /** Timeline entries seen (top-level, incl. cursors and modules). */
  entries: number;
  /** Posts produced (before any hard filtering). */
  posts: number;
  skipped: Record<HomeTimelineSkipReason, number>;
}

export interface HomeTimelineParseResult {
  posts: Post[];
  stats: HomeTimelineParseStats;
}

/** Instructions that carry no entries and need no handling. */
const NO_OP_INSTRUCTIONS = new Set([
  "TimelineClearCache",
  "TimelineTerminateTimeline",
  "TimelineShowAlert",
  "TimelineClearEntriesUnreadState",
  "TimelineMarkEntriesUnreadGreaterThanSortIndex",
]);

/** Modules whose tweets are real feed posts (a reply thread), not suggestions. */
const CONVERSATION_MODULE_PREFIXES = ["home-conversation-", "conversationthread-"];

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A positive integer (pixel size), or undefined. */
function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function at(root: unknown, ...path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) node = obj(node)?.[key];
  return node;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

type Unwrapped = { kind: "tweet"; tweet: Json } | { kind: "unavailable" } | { kind: "unknown" };

/** Strips the result wrappers X puts around a tweet. */
function unwrapTweetResult(result: unknown): Unwrapped {
  const node = obj(result);
  if (!node) return { kind: "unknown" };
  switch (node["__typename"]) {
    case "Tweet":
      return { kind: "tweet", tweet: node };
    case "TweetWithVisibilityResults":
      return unwrapTweetResult(node["tweet"]);
    case "TweetTombstone":
    case "TweetUnavailable":
      return { kind: "unavailable" };
    default:
      // Older/variant shapes omit __typename; a legacy block is enough.
      return obj(node["legacy"]) ? { kind: "tweet", tweet: node } : { kind: "unknown" };
  }
}

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

interface TweetText {
  text: string;
  media: PostMedia[];
}

/** Playable MP4 renditions, highest bitrate first (HLS playlists left out). */
function mp4Variants(raw: unknown): VideoVariant[] | undefined {
  const variants: VideoVariant[] = [];
  for (const entry of arr(raw)) {
    const v = obj(entry);
    const url = str(v?.["url"]);
    if (v?.["content_type"] !== "video/mp4" || !url || !isUrl(url)) continue;
    if (variants.some((known) => known.url === url)) continue;
    const bitrate = count(v["bitrate"]);
    variants.push(bitrate !== undefined ? { url, bitrate: Math.round(bitrate) } : { url });
  }
  variants.sort((a, b) => (b.bitrate ?? -1) - (a.bitrate ?? -1));
  return variants.length > 0 ? variants : undefined;
}

/** One photo/video/GIF entry of `extended_entities.media`; undefined if unusable. */
function mediaEntry(m: Json | undefined): PostMedia | undefined {
  const url = str(m?.["media_url_https"]);
  const type =
    m?.["type"] === "photo"
      ? "photo"
      : m?.["type"] === "video"
        ? "video"
        : m?.["type"] === "animated_gif"
          ? "gif"
          : undefined;
  if (!m || !type || !url || !isUrl(url)) return undefined;
  const altText = str(m["ext_alt_text"]);
  const width = dimension(at(m, "original_info", "width"));
  const height = dimension(at(m, "original_info", "height"));
  const duration = type === "video" ? count(at(m, "video_info", "duration_millis")) : undefined;
  const variants = type === "photo" ? undefined : mp4Variants(at(m, "video_info", "variants"));
  return {
    type,
    url,
    ...(altText ? { altText } : {}),
    ...(width && height ? { width, height } : {}),
    ...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
    ...(variants ? { variants } : {}),
  };
}

/** Card image keys, largest original first (X summary/summary_large_image cards). */
const CARD_IMAGE_KEYS = [
  "photo_image_full_size_original",
  "summary_photo_image_original",
  "thumbnail_image_original",
  "photo_image_full_size_large",
  "summary_photo_image_large",
  "thumbnail_image_large",
  "thumbnail_image",
];

interface TweetCard {
  /** The short link the card belongs to (matches `entities.urls[].url`). */
  shortUrl: string | undefined;
  card: LinkCard;
}

/**
 * Link preview from `card.legacy.binding_values`. Most organic cards
 * arrive as a bare `card.rest_id` with no values; then there is none.
 */
function tweetCard(tweet: Json): TweetCard | undefined {
  const legacy = obj(at(tweet, "card", "legacy"));
  if (!legacy) return undefined;
  const values = new Map<string, Json>();
  for (const binding of arr(legacy["binding_values"])) {
    const key = str(obj(binding)?.["key"]);
    const value = obj(obj(binding)?.["value"]);
    if (key && value) values.set(key, value);
  }
  const text = (key: string): string | undefined =>
    str(values.get(key)?.["string_value"])?.trim() || undefined;
  let image: SizedImage | undefined;
  for (const key of CARD_IMAGE_KEYS) {
    const raw = obj(values.get(key)?.["image_value"]);
    const url = str(raw?.["url"]);
    if (!url || !isUrl(url)) continue;
    const width = dimension(raw?.["width"]);
    const height = dimension(raw?.["height"]);
    image = { url, ...(width && height ? { width, height } : {}) };
    break;
  }
  const title = text("title");
  const description = text("description");
  const domain = text("vanity_url") ?? text("domain");
  if (!title && !description && !image) return undefined;
  return {
    shortUrl: text("card_url") ?? str(legacy["url"]),
    card: {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(domain ? { domain } : {}),
      ...(image ? { image } : {}),
    },
  };
}

/**
 * Own text of a tweet: the long-form note text when present, t.co link
 * placeholders swapped for their expanded URLs, media/quote placeholder
 * links removed, X's HTML escaping undone. Link targets also become
 * "link" media so their domains travel as a signal.
 */
function tweetText(tweet: Json): TweetText {
  const legacy = obj(tweet["legacy"]) ?? {};
  const note = obj(at(tweet, "note_tweet", "note_tweet_results", "result"));
  let text = str(note?.["text"]) ?? str(legacy["full_text"]) ?? "";
  const urls = note ? arr(at(note, "entity_set", "urls")) : arr(at(legacy, "entities", "urls"));
  const quotePermalink = str(at(legacy, "quoted_status_permalink", "url"));

  const links: PostMedia[] = [];
  /** Short link → index in `links`, to find the link a card belongs to. */
  const linkIndexByShort = new Map<string, number>();
  for (const entry of urls) {
    const short = str(obj(entry)?.["url"]);
    const expanded = str(obj(entry)?.["expanded_url"]);
    if (!short) continue;
    if (short === quotePermalink || !expanded || !isUrl(expanded)) {
      text = text.replaceAll(short, "");
      continue;
    }
    text = text.replaceAll(short, expanded);
    let index = links.findIndex((link) => link.url === expanded);
    if (index < 0) index = links.push({ type: "link", url: expanded }) - 1;
    linkIndexByShort.set(short, index);
  }
  if (quotePermalink) text = text.replaceAll(quotePermalink, "");

  // X previews one link per tweet: the card's own link, else the last one.
  const card = tweetCard(tweet);
  if (card && links.length > 0) {
    const index =
      (card.shortUrl !== undefined ? linkIndexByShort.get(card.shortUrl) : undefined) ??
      links.length - 1;
    links[index] = { ...(links[index] as PostMedia), card: card.card };
  }

  const media: PostMedia[] = [];
  const mediaEntries = arr(at(legacy, "extended_entities", "media"));
  for (const entry of mediaEntries.length > 0
    ? mediaEntries
    : arr(at(legacy, "entities", "media"))) {
    const m = obj(entry);
    const short = str(m?.["url"]);
    if (short) text = text.replaceAll(short, "");
    const item = mediaEntry(m);
    if (item) media.push(item);
  }

  text = text.replace(/&(amp|lt|gt);/g, (entity) => HTML_ENTITIES[entity] ?? entity).trim();
  return { text, media: [...media, ...links] };
}

interface Author {
  handle: string;
  name: string | undefined;
  verified: boolean | undefined;
  avatarUrl: string | undefined;
}

function tweetAuthor(tweet: Json): Author | undefined {
  const user = obj(at(tweet, "core", "user_results", "result"));
  const handle = str(at(user, "core", "screen_name")) ?? str(at(user, "legacy", "screen_name"));
  if (!user || !handle) return undefined;
  const flags = [
    user["is_blue_verified"],
    at(user, "verification", "verified"),
    at(user, "legacy", "verified"),
  ];
  const verified =
    flags.some((flag) => flag === true) || str(at(user, "verification", "verified_type"))
      ? true
      : flags.some((flag) => flag === false)
        ? false
        : undefined;
  const avatarUrl =
    str(at(user, "avatar", "image_url")) ?? str(at(user, "legacy", "profile_image_url_https"));
  return {
    handle,
    name: str(at(user, "core", "name")) ?? str(at(user, "legacy", "name")),
    verified,
    avatarUrl: avatarUrl && isUrl(avatarUrl) ? avatarUrl : undefined,
  };
}

/** `legacy.created_at` as epoch ms (NaN when missing or unparseable). */
function createdAtOf(tweet: Json): number {
  return Date.parse(str(at(tweet, "legacy", "created_at")) ?? "");
}

function tweetId(tweet: Json): string | undefined {
  return str(tweet["rest_id"]) ?? str(at(tweet, "legacy", "id_str"));
}

/** The quoted tweet, if X delivered it. */
function quotedOf(tweet: Json): Post["quoted"] {
  const unwrapped = unwrapTweetResult(at(tweet, "quoted_status_result", "result"));
  if (unwrapped.kind !== "tweet") return undefined;
  const id = tweetId(unwrapped.tweet);
  const author = tweetAuthor(unwrapped.tweet);
  if (!id || !author) return undefined;
  const { text, media } = tweetText(unwrapped.tweet);
  const createdAt = createdAtOf(unwrapped.tweet);
  return {
    id,
    authorHandle: author.handle,
    text,
    ...(author.name ? { authorName: author.name } : {}),
    ...(author.verified !== undefined ? { authorVerified: author.verified } : {}),
    ...(Number.isNaN(createdAt) ? {} : { publishedAt: new Date(createdAt).toISOString() }),
    ...(media.length > 0 ? { media } : {}),
  };
}

/** Builds a Post from one (already unwrapped) tweet; undefined if invalid. */
function tweetToPost(tweet: Json, promoted: boolean): Post | undefined {
  const legacy = obj(tweet["legacy"]);
  const retweeted = unwrapTweetResult(at(legacy, "retweeted_status_result", "result"));
  if (retweeted.kind === "tweet") {
    // A repost carries a truncated "RT @…" copy; the original is the content.
    const reposter = tweetAuthor(tweet);
    const original = tweetToPost(retweeted.tweet, promoted);
    if (!original || !reposter) return undefined;
    return { ...original, repostedBy: reposter.handle };
  }

  const id = tweetId(tweet);
  const author = tweetAuthor(tweet);
  const createdAt = createdAtOf(tweet);
  if (!legacy || !id || !author || Number.isNaN(createdAt)) return undefined;

  const { text, media } = tweetText(tweet);
  const quoted = quotedOf(tweet);
  const lang = str(legacy["lang"]);
  const metrics: NonNullable<Post["metrics"]> = {};
  const metricFields = [
    ["likes", legacy["favorite_count"]],
    ["reposts", legacy["retweet_count"]],
    ["replies", legacy["reply_count"]],
    ["quotes", legacy["quote_count"]],
    ["views", at(tweet, "views", "count")],
  ] as const;
  for (const [key, raw] of metricFields) {
    const value = count(raw);
    if (value !== undefined) metrics[key] = value;
  }

  const candidate: Post = {
    id,
    source: X_HOME_TIMELINE_SOURCE,
    authorHandle: author.handle,
    ...(author.name ? { authorName: author.name } : {}),
    ...(author.avatarUrl ? { authorAvatarUrl: author.avatarUrl } : {}),
    text,
    url: `https://x.com/${encodeURIComponent(author.handle)}/status/${encodeURIComponent(id)}`,
    publishedAt: new Date(createdAt).toISOString(),
    media,
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    promoted,
    ...(author.verified !== undefined ? { authorVerified: author.verified } : {}),
    ...(lang ? { lang } : {}),
    ...(quoted ? { quoted } : {}),
    ...(text === "" && !quoted?.text && media.some((m) => m.type !== "link")
      ? { mediaOnly: true }
      : {}),
  };
  const parsed = PostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function emptyStats(): HomeTimelineParseStats {
  return {
    entries: 0,
    posts: 0,
    skipped: {
      cursor: 0,
      "suggestion-module": 0,
      "non-tweet-item": 0,
      unavailable: 0,
      "invalid-tweet": 0,
      "unknown-entry": 0,
      "unknown-instruction": 0,
    },
  };
}

class Collector {
  readonly posts: Post[] = [];
  readonly stats = emptyStats();

  skip(reason: HomeTimelineSkipReason): void {
    this.stats.skipped[reason] += 1;
  }

  /** One timeline item's itemContent (top-level item or module item). */
  item(itemContent: unknown, entryId: string): void {
    const content = obj(itemContent);
    if (!content) return this.skip("unknown-entry");
    if (content["itemType"] !== "TimelineTweet" && content["__typename"] !== "TimelineTweet") {
      return this.skip("non-tweet-item");
    }
    const unwrapped = unwrapTweetResult(at(content, "tweet_results", "result"));
    if (unwrapped.kind === "unavailable") return this.skip("unavailable");
    if (unwrapped.kind === "unknown") return this.skip("unknown-entry");
    const promoted =
      entryId.startsWith("promoted") || obj(content["promotedMetadata"]) !== undefined;
    const post = tweetToPost(unwrapped.tweet, promoted);
    if (!post) return this.skip("invalid-tweet");
    this.posts.push(post);
    this.stats.posts += 1;
  }

  moduleItems(items: unknown, moduleEntryId: string): void {
    const isConversation = CONVERSATION_MODULE_PREFIXES.some((prefix) =>
      moduleEntryId.startsWith(prefix),
    );
    if (!isConversation) return this.skip("suggestion-module");
    for (const moduleItem of arr(items)) {
      const entryId = str(obj(moduleItem)?.["entryId"]) ?? "";
      this.item(at(moduleItem, "item", "itemContent"), entryId);
    }
  }

  entry(rawEntry: unknown): void {
    this.stats.entries += 1;
    const entry = obj(rawEntry);
    const entryId = str(entry?.["entryId"]) ?? "";
    const content = obj(entry?.["content"]);
    const type = content?.["entryType"] ?? content?.["__typename"];
    if (!content) return this.skip("unknown-entry");
    if (type === "TimelineTimelineCursor" || entryId.startsWith("cursor-")) {
      return this.skip("cursor");
    }
    if (type === "TimelineTimelineItem") return this.item(content["itemContent"], entryId);
    if (type === "TimelineTimelineModule") return this.moduleItems(content["items"], entryId);
    this.skip("unknown-entry");
  }

  instruction(rawInstruction: unknown): void {
    const instruction = obj(rawInstruction);
    const type = instruction?.["type"];
    switch (type) {
      case "TimelineAddEntries":
        for (const entry of arr(instruction?.["entries"])) this.entry(entry);
        return;
      case "TimelineReplaceEntry":
      case "TimelinePinEntry":
        this.entry(instruction?.["entry"]);
        return;
      case "TimelineAddToModule":
        this.moduleItems(
          instruction?.["moduleItems"],
          str(instruction?.["moduleEntryId"]) ?? "",
        );
        return;
      default:
        if (typeof type === "string" && NO_OP_INSTRUCTIONS.has(type)) return;
        this.skip("unknown-instruction");
    }
  }
}

/** Parses one HomeTimeline response; never throws on unknown shapes. */
export function parseHomeTimelineWithStats(payload: unknown): HomeTimelineParseResult {
  const collector = new Collector();
  const instructions = at(payload, "data", "home", "home_timeline_urt", "instructions");
  for (const instruction of arr(instructions)) collector.instruction(instruction);
  return { posts: collector.posts, stats: collector.stats };
}

export function parseHomeTimeline(payload: unknown): Post[] {
  return parseHomeTimelineWithStats(payload).posts;
}
