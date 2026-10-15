import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHardFilter } from "../hard-filter.js";
import { PostSchema, type Post } from "../schemas.js";
import { parseHomeTimeline, parseHomeTimelineWithStats } from "./home-timeline.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Fully synthetic responses shaped like real HomeTimeline bodies. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(here, "..", "..", "fixtures", "x-home-timeline", name), "utf8"),
  ) as unknown;
}

function byId(posts: readonly Post[], id: string): Post {
  const post = posts.find((p) => p.id === id);
  if (!post) throw new Error(`no post ${id}`);
  return post;
}

describe("parseHomeTimeline (synthetic fixture)", () => {
  const first = parseHomeTimelineWithStats(fixture("response-1.json"));
  const second = parseHomeTimelineWithStats(fixture("response-2.json"));

  it("produces schema-valid posts and counts every skipped entry", () => {
    for (const post of [...first.posts, ...second.posts]) {
      expect(PostSchema.safeParse(post).success).toBe(true);
      expect(post.url).toMatch(/^https:\/\/x\.com\//);
    }
    expect(first.stats).toEqual({
      entries: 9,
      posts: 5,
      skipped: {
        cursor: 2,
        "suggestion-module": 1,
        "non-tweet-item": 0,
        unavailable: 1,
        "invalid-tweet": 0,
        "unknown-entry": 0,
        "unknown-instruction": 0,
      },
    });
    expect(second.stats).toEqual({
      entries: 8,
      posts: 4,
      skipped: {
        cursor: 2,
        "suggestion-module": 0,
        "non-tweet-item": 0,
        unavailable: 0,
        "invalid-tweet": 1,
        "unknown-entry": 1,
        "unknown-instruction": 1,
      },
    });
  });

  it("maps author, date, metrics, language and expanded links", () => {
    const post = byId(first.posts, "1000000000000000001");
    expect(post).toMatchObject({
      source: "x-home-timeline",
      authorHandle: "synthetic_user_1",
      authorName: "Synthetic User 1",
      authorVerified: true,
      lang: "en",
      publishedAt: "2026-01-01T11:58:00.000Z",
      url: "https://x.com/synthetic_user_1/status/1000000000000000001",
      metrics: { likes: 12, reposts: 3, replies: 4, quotes: 1, views: 1500 },
      promoted: false,
    });
    // t.co-style placeholder swapped for the target; HTML escaping undone.
    expect(post.text).toBe(
      "Library opens a new reading room downtown & extends hours https://news.example.invalid/reading-room",
    );
    expect(post.media).toEqual([
      { type: "link", url: "https://news.example.invalid/reading-room" },
    ]);
  });

  it("flags a text-less photo post as media-only and keeps its alt text", () => {
    const post = byId(first.posts, "1000000000000000002");
    expect(post.text).toBe("");
    expect(post.mediaOnly).toBe(true);
    expect(post.media).toEqual([
      {
        type: "photo",
        url: "https://media.example.invalid/1.jpg",
        altText: "A synthetic sunset",
      },
    ]);
  });

  it("unwraps visibility wrappers and attaches the quoted post without its permalink", () => {
    const post = byId(first.posts, "1000000000000000004");
    expect(post.text).toBe("Worth reading the whole thing");
    expect(post.media).toEqual([]);
    expect(post.quoted).toEqual({
      id: "1000000000000000003",
      authorHandle: "synthetic_user_3",
      text: "Council approves the synthetic bridge budget.",
      authorName: "Synthetic User 3",
      authorVerified: true,
      publishedAt: "2026-01-01T11:58:00.000Z",
    });
  });

  it("prefers the full long-form note text over the truncated legacy text", () => {
    const post = byId(first.posts, "1000000000000000005");
    expect(post.text.length).toBeGreaterThan(280);
    expect(post.text.endsWith("…")).toBe(false);
  });

  it("marks promoted entries", () => {
    expect(byId(first.posts, "1000000000000000006").promoted).toBe(true);
  });

  it("turns a repost into the original post, remembering the reposter", () => {
    const reposts = second.posts.filter((p) => p.repostedBy !== undefined);
    expect(reposts.map((p) => p.repostedBy)).toEqual(["synthetic_user_8", "synthetic_user_9"]);
    for (const post of reposts) {
      expect(post.id).toBe("1000000000000000007");
      expect(post.authorHandle).toBe("synthetic_user_7");
      expect(post.text).not.toMatch(/^RT @/);
    }
  });

  it("never throws on garbage", () => {
    for (const payload of [
      null,
      42,
      "x",
      [],
      {},
      { data: { home: { home_timeline_urt: {} } } },
    ]) {
      expect(parseHomeTimeline(payload)).toEqual([]);
    }
    expect(
      parseHomeTimelineWithStats({
        data: {
          home: {
            home_timeline_urt: {
              instructions: [{ type: "TimelineAddEntries", entries: [null, 1] }],
            },
          },
        },
      }).stats.skipped["unknown-entry"],
    ).toBe(2);
  });
});

describe("createHardFilter", () => {
  it("drops promoted and repeated posts across responses, keeps media-only flagged", () => {
    const filter = createHardFilter();
    const posts = [
      ...parseHomeTimeline(fixture("response-1.json")),
      ...parseHomeTimeline(fixture("response-2.json")),
    ];
    const kept = posts.filter((post) => filter.keep(post));

    expect(kept.map((p) => p.id)).toEqual([
      "1000000000000000001",
      "1000000000000000002",
      "1000000000000000004",
      "1000000000000000005",
      "1000000000000000007",
    ]);
    expect(filter.stats).toEqual({
      seen: 9,
      kept: 5,
      // Response 2 repeats post 1; original 7 arrives as repost, itself, repost.
      dropped: { promoted: 1, duplicate: 1, "duplicate-repost": 2 },
      flagged: { mediaOnly: 1 },
    });
  });

  it("resumes from a JSON round-tripped snapshot without recounting repeats", () => {
    const first = createHardFilter();
    for (const post of parseHomeTimeline(fixture("response-1.json"))) first.keep(post);
    const state = JSON.parse(JSON.stringify(first.snapshot())) as ReturnType<
      typeof first.snapshot
    >;

    const resumed = createHardFilter(state);
    for (const post of parseHomeTimeline(fixture("response-2.json"))) resumed.keep(post);
    const uninterrupted = createHardFilter();
    for (const post of [
      ...parseHomeTimeline(fixture("response-1.json")),
      ...parseHomeTimeline(fixture("response-2.json")),
    ]) {
      uninterrupted.keep(post);
    }
    expect(resumed.stats).toEqual(uninterrupted.stats);
    expect(resumed.stats.kept).toBe(5);
  });

  it("returns a snapshot, not the live counters", () => {
    const filter = createHardFilter();
    const snapshot = filter.stats;
    snapshot.dropped.promoted = 99;
    expect(filter.stats.dropped.promoted).toBe(0);
  });
});

describe("parseHomeTimeline media, avatars, cards and quotes (synthetic fixture)", () => {
  const { posts, stats } = parseHomeTimelineWithStats(fixture("response-3.json"));

  it("parses every rich entry into a schema-valid post", () => {
    expect(stats.posts).toBe(7);
    for (const post of posts) expect(PostSchema.safeParse(post).success).toBe(true);
  });

  it("keeps photo sizes and alt text, and reads the avatar (new and legacy shapes)", () => {
    const post = byId(posts, "2000000000000000001");
    expect(post.text).toBe("Two synthetic photos of the harbour");
    expect(post.authorAvatarUrl).toBe(
      "https://pbs.twimg.com/profile_images/90000001/synthetic_normal.jpg",
    );
    expect(post.media).toEqual([
      {
        type: "photo",
        url: "https://pbs.twimg.com/media/synthetic-1.jpg",
        altText: "Synthetic harbour at dawn",
        width: 1200,
        height: 800,
      },
      {
        type: "photo",
        url: "https://pbs.twimg.com/media/synthetic-2.jpg",
        width: 900,
        height: 1600,
      },
    ]);
    expect(byId(posts, "2000000000000000006").authorAvatarUrl).toBe(
      "https://pbs.twimg.com/profile_images/90000006/legacy_normal.jpg",
    );
    expect(byId(posts, "2000000000000000005").authorAvatarUrl).toBeUndefined();
  });

  it("gives a video its poster, size, duration and MP4 variants best-first (no HLS, no repeats)", () => {
    const [video] = byId(posts, "2000000000000000002").media;
    expect(video).toEqual({
      type: "video",
      url: "https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/synthetic.jpg",
      width: 1280,
      height: 720,
      durationMs: 42500,
      variants: [
        {
          url: "https://video.twimg.com/ext_tw_video/2/pu/vid/1280x720/synthetic.mp4",
          bitrate: 2176000,
        },
        {
          url: "https://video.twimg.com/ext_tw_video/2/pu/vid/640x360/synthetic.mp4",
          bitrate: 832000,
        },
        {
          url: "https://video.twimg.com/ext_tw_video/2/pu/vid/480x270/synthetic.mp4",
          bitrate: 256000,
        },
      ],
    });
  });

  it("gives a GIF its MP4 loop but no duration", () => {
    const [gif] = byId(posts, "2000000000000000003").media;
    expect(gif).toEqual({
      type: "gif",
      url: "https://pbs.twimg.com/tweet_video_thumb/synthetic.jpg",
      variants: [{ url: "https://video.twimg.com/tweet_video/synthetic.mp4", bitrate: 0 }],
    });
  });

  it("attaches the link card to the link it names, largest image first", () => {
    expect(byId(posts, "2000000000000000004").media).toEqual([
      { type: "link", url: "https://first.example.invalid/background" },
      {
        type: "link",
        url: "https://report.example.invalid/2026/report",
        card: {
          title: "Synthetic annual report",
          description: "A made-up summary of a made-up report.",
          domain: "report.example.invalid",
          image: { url: "https://pbs.twimg.com/card_img/4/full.jpg", width: 1200, height: 628 },
        },
      },
    ]);
  });

  it("puts an unanchored card on the last link and ignores a bare card id", () => {
    expect(byId(posts, "2000000000000000005").media.map((m) => m.card)).toEqual([
      undefined,
      { title: "Synthetic title only" },
    ]);
    expect(byId(posts, "2000000000000000006").media).toEqual([
      { type: "link", url: "https://bare.example.invalid/x" },
    ]);
  });

  it("carries the quoted post's author name, badge, time and media", () => {
    const post = byId(posts, "2000000000000000007");
    expect(post.text).toBe("Look at this");
    expect(post.quoted).toEqual({
      id: "2000000000000000070",
      authorHandle: "synthetic_media_8",
      text: "Quoted synthetic photo",
      authorName: "Synthetic Media 8",
      authorVerified: false,
      publishedAt: "2026-01-01T12:30:00.000Z",
      media: [
        {
          type: "photo",
          url: "https://pbs.twimg.com/media/synthetic-8.jpg",
          width: 1000,
          height: 1000,
        },
      ],
    });
  });
});
