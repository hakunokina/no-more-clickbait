import { InstagramPostSchema, type InstagramMedia, type InstagramPost } from "../schemas.js";

/**
 * Instagram web home feed → core InstagramPosts.
 *
 * The feed arrives two ways, both carrying the same connection under
 * `xdt_api__v1__feed__timeline__connection`: the first page embedded in
 * the document (`<script type="application/json">`, Relay prefetch
 * blob, several levels deep) and later pages as `/graphql/query`
 * responses (`data.<root>`). The root is found by a recursive key
 * search, not a fixed path — the embedding path is what breaks first.
 *
 * Every edge node is a union of slots, one of them filled: `media` (a
 * followed account's post), `explore_story.media` ("Suggested for
 * you"), `ad.items[]` (ads), and modules that are never posts (stories
 * tray, who-to-follow, "you're all caught up" demarcator, …). Ads are
 * parsed as `promoted` posts and suggestions carry `suggested`, so the
 * hard filter's counters see them; modules are only counted here.
 *
 * Repeats within one payload are dropped by media id; repeats across
 * responses are the hard filter's job. The shape is undocumented and
 * drifts: everything is read defensively, never thrown on. Feed
 * content is untrusted; this module only copies it into schema-
 * validated posts.
 */

export const INSTAGRAM_FEED_ROOT_KEY = "xdt_api__v1__feed__timeline__connection";

/** The edge node slots Instagram's feed union is known to have. */
export const INSTAGRAM_FEED_SLOTS = [
  "media",
  "explore_story",
  "ad",
  "end_of_feed_demarcator",
  "stories_netego",
  "suggested_users",
  "bloks_netego",
  "abra_icebreakers_in_feed_unit",
  "ad4ad_in_webfeed",
] as const;
export type InstagramFeedSlot = (typeof INSTAGRAM_FEED_SLOTS)[number];

export interface InstagramTimelineParseStats {
  /** Non-null feed connections found in the payload. */
  connections: number;
  /** Edges seen across those connections. */
  edges: number;
  /** Posts produced (before any hard filtering). */
  posts: number;
  /**
   * Edges by filled slot; `unknown` = a slot this parser does not know,
   * `empty` = no slot filled.
   */
  slots: Record<InstagramFeedSlot | "unknown" | "empty", number>;
  skipped: {
    /** A post missing required fields (id, code, author, date…). */
    "invalid-media": number;
    /** The same media id again within this payload. */
    repeated: number;
  };
}

export interface InstagramTimelineParseResult {
  posts: InstagramPost[];
  stats: InstagramTimelineParseStats;
}

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

function httpsUrl(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    return new URL(text).protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

const FOR_LOOP_PREFIX = "for (;;);";

/**
 * A captured body as JSON: drops the `for (;;);` anti-hijacking prefix
 * some Instagram endpoints send. Undefined when it is not JSON.
 */
export function parseInstagramBody(bodyText: string): unknown {
  let text = bodyText.trimStart();
  if (text.startsWith(FOR_LOOP_PREFIX)) text = text.slice(FOR_LOOP_PREFIX.length);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Deep enough for the Relay prefetch blob; guards against pathological input. */
const MAX_SEARCH_DEPTH = 64;

/** Every non-null feed connection anywhere in the payload, in document order. */
export function findInstagramFeedConnections(payload: unknown): Json[] {
  const found: Json[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_SEARCH_DEPTH || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node as Json)) {
      if (key === INSTAGRAM_FEED_ROOT_KEY) {
        // A null root is the "wrong endpoint" answer: nothing to count.
        const connection = obj(child);
        if (connection) found.push(connection);
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return found;
}

/**
 * The media id. Prefers string forms: a numeric `pk` above 2^53 has
 * already lost digits in JSON.parse, while `id` ("<pk>_<owner id>") and
 * a string `pk` are exact.
 */
function mediaId(media: Json): string | undefined {
  const pk = media["pk"];
  if (typeof pk === "string" && /^\d+$/.test(pk)) return pk;
  const idPrefix = str(media["id"])?.split("_")[0];
  if (idPrefix && /^\d+$/.test(idPrefix)) return idPrefix;
  return typeof pk === "number" && Number.isSafeInteger(pk) && pk > 0 ? String(pk) : undefined;
}

interface Rendition {
  url: string;
  width?: number;
  height?: number;
}

/** Renditions with a usable https url, widest first. */
function renditions(raw: unknown): Rendition[] {
  const out: Rendition[] = [];
  for (const entry of arr(raw)) {
    const url = httpsUrl(obj(entry)?.["url"]);
    if (!url) continue;
    const width = dimension(obj(entry)?.["width"]);
    const height = dimension(obj(entry)?.["height"]);
    out.push({ url, ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }
  return out.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
}

/** One image or video (a carousel child or the post itself); undefined without an image. */
function toMedia(media: Json): InstagramMedia | undefined {
  const images = renditions(obj(media["image_versions2"])?.["candidates"]);
  const image = images[0];
  if (!image) return undefined;
  const videos = renditions(media["video_versions"]);
  const width = dimension(media["original_width"]) ?? image.width;
  const height = dimension(media["original_height"]) ?? image.height;
  const altText = str(media["accessibility_caption"]);
  const duration = count(media["video_duration"]);
  const video = videos[0];
  return {
    type: video ? "video" : "image",
    url: image.url,
    ...(video ? { videoUrl: video.url, videoVariants: videos } : {}),
    ...(altText ? { altText } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(video && duration !== undefined ? { durationMs: Math.round(duration * 1000) } : {}),
  };
}

function kindOf(media: Json): InstagramPost["kind"] {
  if (media["media_type"] === 8 || arr(media["carousel_media"]).length > 0) return "carousel";
  return media["product_type"] === "clips" ? "reel" : "post";
}

function metricsOf(media: Json): InstagramPost["metrics"] {
  // With counts hidden, like_count is a token small number, not the count.
  const hidden = media["like_and_view_counts_disabled"] === true;
  const likes = hidden ? undefined : count(media["like_count"]);
  const comments = count(media["comment_count"]);
  const views = hidden
    ? undefined
    : (count(media["play_count"]) ??
      count(media["ig_play_count"]) ??
      count(media["view_count"]));
  if (likes === undefined && comments === undefined && views === undefined) return undefined;
  return {
    ...(likes !== undefined ? { likes } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(views !== undefined ? { views } : {}),
  };
}

function coauthorsOf(media: Json, authorHandle: string): InstagramPost["coauthors"] {
  const coauthors: NonNullable<InstagramPost["coauthors"]> = [];
  for (const producer of arr(media["coauthor_producers"])) {
    const handle = str(obj(producer)?.["username"]);
    if (!handle || handle === authorHandle) continue;
    const name = str(obj(producer)?.["full_name"]);
    coauthors.push({ handle, ...(name ? { name } : {}) });
  }
  return coauthors.length > 0 ? coauthors : undefined;
}

function paidPartnershipOf(media: Json): InstagramPost["paidPartnership"] {
  const tags = arr(media["sponsor_tags"]);
  if (media["is_paid_partnership"] !== true && tags.length === 0) return undefined;
  const sponsor = obj(tags[0]);
  const partner = str(obj(sponsor?.["sponsor"])?.["username"]) ?? str(sponsor?.["username"]);
  return partner ? { partner } : {};
}

function isAdMedia(media: Json): boolean {
  return media["product_type"] === "ad" || str(media["ad_id"]) !== undefined;
}

interface MediaContext {
  promoted: boolean;
  suggested: boolean;
}

/** One feed media object → a schema-valid post, or undefined. */
function toPost(media: Json, context: MediaContext): InstagramPost | undefined {
  const id = mediaId(media);
  const code = str(media["code"]);
  const user = obj(media["user"]) ?? obj(media["owner"]);
  const authorHandle = str(user?.["username"]);
  const takenAt = count(media["taken_at"]);
  if (!id || !code || !/^[A-Za-z0-9_-]+$/.test(code) || !authorHandle || !takenAt) {
    return undefined;
  }
  const kind = kindOf(media);
  const children = kind === "carousel" ? arr(media["carousel_media"]) : [media];
  const mediaList = children
    .map((child) => (obj(child) ? toMedia(obj(child) as Json) : undefined))
    .filter((item): item is InstagramMedia => item !== undefined);
  const authorName = str(user?.["full_name"]);
  const authorAvatarUrl = httpsUrl(user?.["profile_pic_url"]);
  const metrics = metricsOf(media);
  const coauthors = coauthorsOf(media, authorHandle);
  const location = str(obj(media["location"])?.["name"]);
  const paidPartnership = paidPartnershipOf(media);
  const candidate: InstagramPost = {
    platform: "instagram",
    id,
    url: `https://www.instagram.com/${kind === "reel" ? "reel" : "p"}/${code}/`,
    authorHandle,
    ...(authorName ? { authorName } : {}),
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    ...(typeof user?.["is_verified"] === "boolean"
      ? { authorVerified: user["is_verified"] }
      : {}),
    caption: str(obj(media["caption"])?.["text"]) ?? "",
    kind,
    media: mediaList,
    publishedAt: new Date(takenAt * 1000).toISOString(),
    ...(metrics ? { metrics } : {}),
    promoted: context.promoted || isAdMedia(media),
    ...(context.suggested ? { suggested: true } : {}),
    ...(coauthors ? { coauthors } : {}),
    ...(location ? { location } : {}),
    ...(paidPartnership ? { paidPartnership } : {}),
  };
  const parsed = InstagramPostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function emptyStats(): InstagramTimelineParseStats {
  const slots = Object.fromEntries(
    [...INSTAGRAM_FEED_SLOTS, "unknown", "empty"].map((slot) => [slot, 0]),
  ) as InstagramTimelineParseStats["slots"];
  return {
    connections: 0,
    edges: 0,
    posts: 0,
    slots,
    skipped: { "invalid-media": 0, repeated: 0 },
  };
}

const KNOWN_SLOTS: ReadonlySet<string> = new Set(INSTAGRAM_FEED_SLOTS);

/** The edge node's filled slot: the first known one, else the first non-null key. */
function filledSlot(node: Json): {
  slot: InstagramFeedSlot | "unknown" | "empty";
  value: unknown;
} {
  for (const slot of INSTAGRAM_FEED_SLOTS) {
    const value = node[slot];
    if (value !== null && value !== undefined) return { slot, value };
  }
  const other = Object.entries(node).find(
    ([key, value]) => key !== "__typename" && !KNOWN_SLOTS.has(key) && value !== null,
  );
  return other ? { slot: "unknown", value: other[1] } : { slot: "empty", value: undefined };
}

/** Parses one captured payload (SSR blob or GraphQL response); never throws on unknown shapes. */
export function parseInstagramTimelineWithStats(
  payload: unknown,
): InstagramTimelineParseResult {
  const stats = emptyStats();
  const posts: InstagramPost[] = [];
  const seen = new Set<string>();

  const add = (media: unknown, context: MediaContext): void => {
    const node = obj(media);
    const post = node ? toPost(node, context) : undefined;
    if (!post) {
      stats.skipped["invalid-media"] += 1;
      return;
    }
    if (seen.has(post.id)) {
      stats.skipped.repeated += 1;
      return;
    }
    seen.add(post.id);
    posts.push(post);
    stats.posts += 1;
  };

  for (const connection of findInstagramFeedConnections(payload)) {
    stats.connections += 1;
    for (const edge of arr(connection["edges"])) {
      stats.edges += 1;
      const node = obj(obj(edge)?.["node"]);
      const { slot, value } = node
        ? filledSlot(node)
        : { slot: "empty" as const, value: undefined };
      stats.slots[slot] += 1;
      if (slot === "media") add(value, { promoted: false, suggested: false });
      else if (slot === "explore_story") {
        add(obj(value)?.["media"], { promoted: false, suggested: true });
      } else if (slot === "ad") {
        for (const item of arr(obj(value)?.["items"])) {
          add(obj(item)?.["media"] ?? item, { promoted: true, suggested: false });
        }
      }
    }
  }
  return { posts, stats };
}

export function parseInstagramTimeline(payload: unknown): InstagramPost[] {
  return parseInstagramTimelineWithStats(payload).posts;
}
