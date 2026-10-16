import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { feedItemKey, isMediaOnly } from "../feed-item.js";
import { createHardFilter } from "../hard-filter.js";
import { InstagramPostSchema, type InstagramPost } from "../schemas.js";
import {
  findInstagramFeedConnections,
  parseInstagramBody,
  parseInstagramTimeline,
  parseInstagramTimelineWithStats,
} from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Fully synthetic bodies shaped like the research's description (#1961); no real data. */
function fixtureText(name: string): string {
  return readFileSync(join(here, "..", "..", "fixtures", "instagram-feed", name), "utf8");
}

function byId(posts: readonly InstagramPost[], id: string): InstagramPost {
  const post = posts.find((p) => p.id === id);
  if (!post) throw new Error(`no post ${id}`);
  return post;
}

describe("parseInstagramTimeline (synthetic fixtures)", () => {
  const ssr = parseInstagramTimelineWithStats(
    parseInstagramBody(fixtureText("ssr-block.json")),
  );
  const page2 = parseInstagramTimelineWithStats(
    parseInstagramBody(fixtureText("graphql-page-2.txt")),
  );

  it("finds the feed root deep in the document blob and counts every slot", () => {
    expect(ssr.stats).toEqual({
      connections: 1,
      edges: 10,
      posts: 6,
      slots: {
        media: 6,
        explore_story: 1,
        ad: 1,
        end_of_feed_demarcator: 0,
        stories_netego: 1,
        suggested_users: 1,
        bloks_netego: 0,
        abra_icebreakers_in_feed_unit: 0,
        ad4ad_in_webfeed: 0,
        unknown: 0,
        empty: 0,
      },
      skipped: { "invalid-media": 1, repeated: 1, "ad-carousel-card": 0 },
    });
    for (const post of [...ssr.posts, ...page2.posts]) {
      expect(InstagramPostSchema.safeParse(post).success).toBe(true);
    }
  });

  it("maps a photo post: permalink, author, caption, media size, metrics, location", () => {
    expect(byId(ssr.posts, "3100000000000000001")).toEqual({
      platform: "instagram",
      id: "3100000000000000001",
      url: "https://www.instagram.com/p/SYNTHa1/",
      authorHandle: "example_alpha",
      authorName: "Example Alpha",
      authorAvatarUrl: "https://media.example/avatar/alpha.jpg",
      authorVerified: true,
      caption: "Synthetic caption: a long walk along an invented coastline.",
      kind: "post",
      media: [
        {
          type: "image",
          url: "https://media.example/a1-1080.jpg",
          altText: "Synthetic alt text: a beach.",
          width: 1080,
          height: 1350,
        },
      ],
      publishedAt: new Date(1791000000 * 1000).toISOString(),
      metrics: { likes: 120, comments: 7 },
      promoted: false,
      location: "Synthetic Bay",
    });
  });

  it("maps a reel: poster, widest video first with every variant, duration, plays", () => {
    const reel = byId(ssr.posts, "3100000000000000002");
    expect(reel.kind).toBe("reel");
    expect(reel.url).toBe("https://www.instagram.com/reel/SYNTHr2/");
    expect(reel.media).toEqual([
      {
        type: "video",
        url: "https://media.example/r2-poster.jpg",
        videoUrl: "https://media.example/r2-720.mp4",
        videoVariants: [
          { url: "https://media.example/r2-720.mp4", width: 720, height: 1280 },
          { url: "https://media.example/r2-480.mp4", width: 480, height: 854 },
        ],
        width: 720,
        height: 1280,
        durationMs: 12_500,
      },
    ]);
    expect(reel.metrics).toEqual({ likes: 40, comments: 2, views: 900 });
  });

  it("flags suggested posts (kept) and maps carousels child by child", () => {
    const carousel = byId(ssr.posts, "3100000000000000004");
    expect(carousel.suggested).toBe(true);
    expect(carousel.promoted).toBe(false);
    expect(carousel.kind).toBe("carousel");
    expect(carousel.media.map((m) => [m.type, m.width, m.height, m.durationMs])).toEqual([
      ["image", 1080, 1080, undefined],
      ["video", 1080, 1920, 3000],
    ]);
    expect(byId(page2.posts, "3100000000000000013").suggested).toBe(true);
    expect(byId(ssr.posts, "3100000000000000001").suggested).toBeUndefined();
  });

  it("parses ads as promoted posts", () => {
    expect(byId(ssr.posts, "3100000000000000005").promoted).toBe(true);
  });

  it("counts an ad carousel's cards apart, not as invalid posts", () => {
    // Shape seen in a real dump (keys only): the ad lists its own media and,
    // flat next to it, its carousel cards — no code, author or date.
    const ad = {
      pk: "3100000000000000090",
      code: "AdCode90",
      taken_at: 1791000000,
      user: { username: "brand.synthetic" },
      product_type: "ad",
      image_versions2: { candidates: [{ url: "https://cdn.example/ad.jpg" }] },
    };
    const card = (n: number) => ({
      pk: `310000000000000009${n}`,
      id: `310000000000000009${n}_1`,
      carousel_parent_id: "3100000000000000090_1",
      image_versions2: { candidates: [{ url: `https://cdn.example/card${n}.jpg` }] },
    });
    const result = parseInstagramTimelineWithStats({
      xdt_api__v1__feed__timeline__connection: {
        edges: [{ node: { ad: { items: [ad, card(1), card(2)] } } }],
      },
    });
    expect(result.posts.map((post) => [post.id, post.promoted])).toEqual([
      ["3100000000000000090", true],
    ]);
    expect(result.stats.skipped).toEqual({
      "invalid-media": 0,
      repeated: 0,
      "ad-carousel-card": 2,
    });
  });

  it("takes the id from the exact `id` string when a numeric pk lost digits", () => {
    const post = byId(ssr.posts, "3100000000000000006");
    expect(post.caption).toBe("");
    expect(isMediaOnly(post)).toBe(true);
  });

  it("hides fake like counts, keeps comments, co-authors and the paid partnership", () => {
    const post = byId(ssr.posts, "3100000000000000009");
    expect(post.metrics).toEqual({ comments: 12 });
    expect(post.authorVerified).toBe(false);
    expect(post.coauthors).toEqual([{ handle: "example_zeta", name: "Example Zeta" }]);
    expect(post.paidPartnership).toEqual({ partner: "example_sponsor" });
  });

  it("strips the for(;;); prefix and counts demarcator, unknown and empty nodes", () => {
    expect(page2.stats).toMatchObject({
      connections: 1,
      edges: 6,
      posts: 3,
      slots: { media: 2, explore_story: 1, end_of_feed_demarcator: 1, unknown: 1, empty: 1 },
      skipped: { "invalid-media": 0, repeated: 0, "ad-carousel-card": 0 },
    });
  });

  it("does not count a null root (wrong-endpoint answer)", () => {
    const payload = parseInstagramBody(fixtureText("graphql-null-root.json"));
    expect(findInstagramFeedConnections(payload)).toEqual([]);
    expect(parseInstagramTimelineWithStats(payload).stats.connections).toBe(0);
  });

  it("never throws on junk", () => {
    expect(parseInstagramBody("<html>")).toBeUndefined();
    for (const junk of [undefined, null, 42, "x", [], { data: { [""]: 1 } }]) {
      expect(parseInstagramTimeline(junk)).toEqual([]);
    }
    expect(
      parseInstagramTimeline({
        xdt_api__v1__feed__timeline__connection: { edges: [null, { node: { media: 7 } }] },
      }),
    ).toEqual([]);
    // taken_at past Date's range (bad or changed schema): skipped, not a RangeError.
    const media = { pk: "1", code: "abc", user: { username: "someone" } };
    const control = parseInstagramTimeline({
      xdt_api__v1__feed__timeline__connection: {
        edges: [{ node: { media: { ...media, taken_at: 1791000000 } } }],
      },
    });
    expect(control).toHaveLength(1);
    for (const takenAt of [1e13, Number.MAX_SAFE_INTEGER, "9e15"]) {
      const result = parseInstagramTimelineWithStats({
        xdt_api__v1__feed__timeline__connection: {
          edges: [{ node: { media: { ...media, taken_at: takenAt } } }],
        },
      });
      expect(result.posts).toEqual([]);
      expect(result.stats.skipped["invalid-media"]).toBe(1);
    }
  });

  it("feeds the hard filter: ad dropped, cross-response repeat dropped, caption-less flagged", () => {
    const filter = createHardFilter();
    const kept = [...ssr.posts, ...page2.posts].filter((post) => filter.keep(post));
    expect(filter.stats).toEqual({
      seen: 9,
      kept: 7,
      dropped: { promoted: 1, duplicate: 1, "duplicate-repost": 0 },
      flagged: { mediaOnly: 2 },
    });
    expect(kept.map(feedItemKey)).toContain("instagram:3100000000000000004");
  });
});
