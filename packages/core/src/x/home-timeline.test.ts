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
