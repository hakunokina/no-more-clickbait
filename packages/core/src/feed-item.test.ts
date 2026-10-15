import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  feedItemKey,
  feedSourceLabel,
  genericItemIdFromText,
  genericItemIdFromUrl,
  isGenericItem,
  isInstagramPost,
  isMediaOnly,
  isXPost,
  platformOf,
} from "./feed-item.js";
import { createHardFilter } from "./hard-filter.js";
import { FunnelCountsSchema, RunMetricsSchema } from "./metrics.js";
import { createThresholdSelector, runPipeline } from "./pipeline.js";
import {
  FeedItemSchema,
  GenericItemSchema,
  InstagramPostSchema,
  PostSchema,
  RankedPostSchema,
  type FeedItem,
  type GenericItem,
  type InstagramPost,
  type Post,
  type ScoreEntry,
} from "./schemas.js";
import { isXCard, postWordCount, TimelineDocSchema, toTimelineDoc } from "./timeline-doc.js";

function xPost(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    source: "synthetic",
    authorHandle: `user_${id}`,
    text: `text of ${id}`,
    url: `https://example.invalid/posts/${id}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    media: [],
    promoted: false,
    ...overrides,
  };
}

function igPost(id: string, overrides: Partial<InstagramPost> = {}): InstagramPost {
  return {
    platform: "instagram",
    id,
    url: `https://www.instagram.com/p/${id}/`,
    authorHandle: `ig_${id}`,
    caption: `caption of ${id}`,
    kind: "post",
    media: [{ type: "image", url: `https://scontent.cdninstagram.com/v/${id}.jpg` }],
    publishedAt: "2026-01-01T00:00:00.000Z",
    promoted: false,
    ...overrides,
  };
}

function genericItem(id: string, overrides: Partial<GenericItem> = {}): GenericItem {
  return {
    platform: "generic",
    id,
    sourceLabel: "reddit",
    title: `title of ${id}`,
    url: `https://www.reddit.com/r/synthetic/comments/${id}/`,
    domain: "reddit.com",
    promoted: false,
    ...overrides,
  };
}

describe("FeedItemSchema", () => {
  it("reads an untagged object as an X Post, unchanged", () => {
    const post = xPost("1", { repostedBy: "someone", mediaOnly: false });
    const parsed = FeedItemSchema.parse(post);
    expect(parsed).toEqual(post);
    expect(isXPost(parsed)).toBe(true);
    expect(platformOf(parsed)).toBe("x");
    expect(platformOf(FeedItemSchema.parse({ ...post, platform: "x" }))).toBe("x");
  });

  it("parses Instagram posts and generic items by their platform tag", () => {
    const ig = FeedItemSchema.parse(igPost("2"));
    const generic = FeedItemSchema.parse(genericItem("3"));
    expect(isInstagramPost(ig) && platformOf(ig)).toBe("instagram");
    expect(isGenericItem(generic) && platformOf(generic)).toBe("generic");
    // Defaults fill what the source left out.
    const bare = FeedItemSchema.parse({
      platform: "instagram",
      id: "4",
      url: "https://www.instagram.com/p/4/",
      authorHandle: "a",
      kind: "reel",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(bare).toMatchObject({ caption: "", media: [], promoted: false });
  });

  it("never falls back to X for a broken Instagram or generic object", () => {
    // Carries every X field too: still judged as Instagram only.
    const brokenIg = { ...xPost("5"), ...igPost("5"), kind: "story" };
    expect(FeedItemSchema.safeParse(brokenIg).success).toBe(false);
    const brokenGeneric = { ...xPost("6"), ...genericItem("6"), domain: "" };
    expect(FeedItemSchema.safeParse(brokenGeneric).success).toBe(false);
    // Without its tag an Instagram post is not a valid X post either.
    const { platform: _platform, ...untagged } = igPost("7");
    expect(FeedItemSchema.safeParse(untagged).success).toBe(false);
    expect(FeedItemSchema.safeParse({ ...igPost("8"), platform: "tiktok" }).success).toBe(
      false,
    );
  });

  it("allows only http(s) URLs on generic items", () => {
    const item = genericItem("9", { url: "javascript:alert(1)" });
    expect(FeedItemSchema.safeParse(item).success).toBe(false);
  });

  it("keeps ranked X posts readable from before (no platform written)", () => {
    const ranked = {
      post: xPost("10"),
      score: {
        postId: "10",
        clickbaitScore: 0,
        readWorthinessScore: 1,
        checkWorthyClaim: null,
      },
      verification: null,
    };
    expect(RankedPostSchema.parse(ranked).post).not.toHaveProperty("platform");
  });
});

describe("card fields of Instagram and generic items", () => {
  it("accepts the optional card fields and keeps them", () => {
    const ig = igPost("1", {
      lang: "tr",
      coauthors: [{ handle: "ortak_hesap", name: "Ortak Hesap" }, { handle: "ikinci" }],
      location: "Sentetik Park",
      paidPartnership: { partner: "Değirmen Un" },
    });
    expect(InstagramPostSchema.parse(ig)).toEqual(ig);
    const generic = genericItem("1", {
      kind: "link",
      lang: "en",
      linkUrl: "https://news.example.invalid/story",
      flair: "Bilim",
      siteIconUrl: "https://styles.example.invalid/r-synthetic.png",
      image: { url: "https://i.example.invalid/1.jpg", altText: "Bir köprü", width: 640 },
    });
    expect(GenericItemSchema.parse(generic)).toEqual(generic);
    // A paid partnership whose brand was not delivered is still labelled.
    expect(
      InstagramPostSchema.parse(igPost("2", { paidPartnership: {} })).paidPartnership,
    ).toEqual({});
  });

  it("refuses card fields that would reach the renderer as unsafe or empty", () => {
    const bad: Partial<GenericItem>[] = [
      { linkUrl: "javascript:alert(1)" },
      { siteIconUrl: "data:image/png;base64,AAAA" },
      { kind: "gallery" as GenericItem["kind"] },
      { flair: "" },
    ];
    for (const overrides of bad) {
      expect(GenericItemSchema.safeParse(genericItem("1", overrides)).success).toBe(false);
    }
    expect(
      InstagramPostSchema.safeParse(igPost("1", { coauthors: [{ handle: "" }] })).success,
    ).toBe(false);
  });

  it("leaves the X Post schema as it was", () => {
    expect(Object.keys(PostSchema.shape)).not.toEqual(
      expect.arrayContaining(["kind", "linkUrl", "flair", "siteIconUrl", "coauthors"]),
    );
    const parsed = FeedItemSchema.parse({
      ...xPost("1"),
      flair: "x",
      linkUrl: "https://a.invalid/",
    });
    expect(parsed).not.toHaveProperty("flair");
    expect(parsed).not.toHaveProperty("linkUrl");
  });

  it("labels sources the way the tally names them", () => {
    expect(
      [xPost("1"), igPost("1"), genericItem("1", { sourceLabel: "custom:Haber" })].map(
        feedSourceLabel,
      ),
    ).toEqual(["x", "instagram", "custom:Haber"]);
  });
});

describe("feedItemKey", () => {
  it("keeps an X id bare and puts the source into other keys", () => {
    expect(feedItemKey(xPost("123"))).toBe("123");
    expect(feedItemKey(igPost("123"))).toBe("instagram:123");
    expect(feedItemKey(genericItem("123"))).toBe("generic:reddit:123");
  });

  it("cannot be made to collide through a label containing the separator", () => {
    const a = genericItem("b:c", { sourceLabel: "custom:a" });
    const b = genericItem("c", { sourceLabel: "custom:a:b" });
    expect(feedItemKey(a)).not.toBe(feedItemKey(b));
  });
});

describe("isMediaOnly", () => {
  it("follows each source's notion of 'no text to judge'", () => {
    expect(isMediaOnly(xPost("1", { mediaOnly: true }))).toBe(true);
    expect(isMediaOnly(xPost("1", { text: "" }))).toBe(false);
    expect(isMediaOnly(igPost("2", { caption: "  " }))).toBe(true);
    expect(isMediaOnly(igPost("2"))).toBe(false);
    expect(isMediaOnly(genericItem("3", { title: " ", text: "" }))).toBe(true);
    const textOnly = genericItem("3", { text: "body" });
    delete textOnly.title;
    expect(isMediaOnly(textOnly)).toBe(false);
  });
});

describe("genericItemIdFromUrl", () => {
  it("is stable, ignores the fragment and tells pages apart", () => {
    const id = genericItemIdFromUrl("https://news.example.invalid/a?x=1");
    expect(id).toMatch(/^u[0-9a-f]{16}$/);
    expect(genericItemIdFromUrl("https://news.example.invalid/a?x=1#comments")).toBe(id);
    expect(genericItemIdFromUrl("https://NEWS.example.invalid/a?x=1")).toBe(id);
    expect(genericItemIdFromUrl("https://news.example.invalid/a?x=2")).not.toBe(id);
  });

  it("does not throw on a string that is not a URL", () => {
    const id = genericItemIdFromUrl(" not a url ");
    expect(id).toMatch(/^u[0-9a-f]{16}$/);
    expect(genericItemIdFromUrl("not a url")).toBe(id);
  });
});

describe("genericItemIdFromText", () => {
  it("is stable and tells texts apart", () => {
    const id = genericItemIdFromText("Başlık\nözet");
    expect(id).toMatch(/^t[0-9a-f]{16}$/);
    expect(genericItemIdFromText("Başlık\nözet")).toBe(id);
    expect(genericItemIdFromText("Başlık\nözet 2")).not.toBe(id);
  });
});

describe("createHardFilter with mixed sources", () => {
  it("dedupes per source + id and drops ads of every source", () => {
    const filter = createHardFilter();
    const kept = [
      xPost("1"),
      igPost("1"),
      genericItem("1"),
      igPost("1"),
      genericItem("1", { sourceLabel: "custom:news" }),
      genericItem("1"),
      igPost("2", { promoted: true }),
      genericItem("2", { promoted: true }),
      igPost("3", { caption: "" }),
    ].filter((item) => filter.keep(item));
    expect(kept.map(feedItemKey)).toEqual([
      "1",
      "instagram:1",
      "generic:reddit:1",
      "generic:custom%3Anews:1",
      "instagram:3",
    ]);
    expect(filter.stats).toEqual({
      seen: 9,
      kept: 5,
      dropped: { promoted: 2, duplicate: 2, "duplicate-repost": 0 },
      flagged: { mediaOnly: 1 },
    });
  });

  it("resumes from a snapshot with the source-qualified keys", () => {
    const first = createHardFilter();
    first.keep(igPost("1"));
    const resumed = createHardFilter(first.snapshot());
    expect(resumed.keep(igPost("1"))).toBe(false);
    expect(resumed.keep(xPost("1"))).toBe(true);
  });
});

describe("runPipeline with mixed sources", () => {
  it("scores, ranks and matches every source by its key", async () => {
    const items: FeedItem[] = [
      xPost("1"),
      igPost("1"),
      genericItem("1"),
      igPost("2", { caption: "" }),
      genericItem("2", { promoted: true }),
    ];
    const read: Record<string, number> = {
      "1": 0.5,
      "instagram:1": 0.9,
      "generic:reddit:1": 0.7,
    };
    let scored: string[] = [];
    const result = await runPipeline(
      {
        hardFilter: createHardFilter(),
        scorer: {
          async score(posts) {
            scored = posts.map(feedItemKey);
            return posts.map((post): ScoreEntry => ({
              postId: feedItemKey(post),
              clickbaitScore: 0.1,
              readWorthinessScore: read[feedItemKey(post)] ?? 0,
              checkWorthyClaim: null,
            }));
          },
        },
        selector: createThresholdSelector({
          maxClickbaitScore: 0.7,
          minReadWorthinessScore: 0.2,
        }),
      },
      items,
      { timelineSize: 10, verifyConcurrency: 2 },
    );
    expect(scored).toEqual(["1", "instagram:1", "generic:reddit:1"]);
    expect(result.posts.map(({ post }) => feedItemKey(post))).toEqual([
      "instagram:1",
      "generic:reddit:1",
      "1",
    ]);
    expect(result.unjudged.map(feedItemKey)).toEqual(["instagram:2"]);
    expect(FunnelCountsSchema.parse(result.funnel)).toMatchObject({
      scanned: 5,
      ads: 1,
      mediaOnly: 1,
      shown: 3,
    });
    // Scanned/shown per source, in order of first appearance; ads and
    // media-only posts count as scanned.
    expect(result.metrics.bySource).toEqual([
      { label: "x", in: 1, shown: 1 },
      { label: "instagram", in: 2, shown: 1 },
      { label: "reddit", in: 2, shown: 1 },
    ]);
    expect(RunMetricsSchema.parse(result.metrics).bySource).toEqual(result.metrics.bySource);
  });

  it("verifies non-X items with their own key", async () => {
    const claimed: string[] = [];
    const result = await runPipeline(
      {
        hardFilter: createHardFilter(),
        scorer: {
          score: async (posts) =>
            posts.map((post) => ({
              postId: feedItemKey(post),
              clickbaitScore: 0,
              readWorthinessScore: 0.9,
              checkWorthy: true,
              checkWorthyClaim: `claim of ${feedItemKey(post)}`,
            })),
        },
        selector: createThresholdSelector({
          maxClickbaitScore: 0.7,
          minReadWorthinessScore: 0.2,
        }),
        verifier: {
          async verify(post, claim) {
            claimed.push(claim);
            return {
              postId: feedItemKey(post),
              claim,
              status: isGenericItem(post) ? "false_or_disputed" : "verified",
              confidence: 0.8,
              summary: "Kaynaklar.",
              sources: [{ url: "https://example.invalid/s", title: "s" }],
            };
          },
        },
      },
      [igPost("1"), genericItem("1")],
      { timelineSize: 5, verifyConcurrency: 2 },
    );
    expect(claimed).toEqual(["claim of instagram:1", "claim of generic:reddit:1"]);
    expect(result.posts.map(({ post }) => feedItemKey(post))).toEqual(["instagram:1"]);
    expect(result.funnel.contradicted).toBe(1);
  });
});

describe("TimelineDoc with mixed sources", () => {
  const mixed = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "fixtures",
        "timeline-doc-mixed.json",
      ),
      "utf8",
    ),
  ) as unknown;

  it("parses the synthetic mixed fixture, every card under its own source", () => {
    const doc = TimelineDocSchema.parse(mixed);
    expect(doc.cards.map((card) => platformOf(card.post))).toEqual([
      "x",
      "generic",
      "generic",
      "instagram",
      "x",
      "instagram",
    ]);
    expect(doc.cards.filter(isXCard).map((card) => card.rank)).toEqual([1, 5]);
    for (const card of doc.cards) expect(card.score.postId).toBe(feedItemKey(card.post));
    const words = doc.cards.reduce((sum, card) => sum + postWordCount(card.post), 0);
    expect(doc.header.wordCount).toBe(words);
    // Every optional card field the renderer binds appears at least once.
    const generic = doc.cards.map((card) => card.post).filter(isGenericItem);
    const ig = doc.cards.map((card) => card.post).filter(isInstagramPost);
    for (const field of ["kind", "lang", "linkUrl", "flair", "siteIconUrl"] as const) {
      expect(generic.some((item) => item[field] !== undefined)).toBe(true);
    }
    expect(generic.some((item) => item.image?.altText)).toBe(true);
    for (const field of ["lang", "coauthors", "location", "paidPartnership"] as const) {
      expect(ig.some((item) => item[field] !== undefined)).toBe(true);
    }
    expect(doc.bySource?.map((count) => count.label)).toEqual([
      "x",
      "reddit",
      "instagram",
      "custom:haber",
    ]);
    expect(doc.missingSources).toEqual([
      { label: "custom:blog", reason: "Site yanıt vermedi" },
    ]);
  });

  it("counts an Instagram caption and a generic title plus text as words", () => {
    expect(postWordCount(igPost("1", { caption: "one two three" }))).toBe(3);
    expect(postWordCount(genericItem("1", { title: "one two", text: "three" }))).toBe(3);
  });

  it("builds cards for every source from a run", () => {
    const selected = [igPost("1"), genericItem("1")].map((post) => ({
      post,
      score: {
        postId: feedItemKey(post),
        clickbaitScore: 0.1,
        readWorthinessScore: 0.8,
        checkWorthyClaim: null,
      },
      verification: null,
    }));
    const funnel = {
      scanned: 2,
      ads: 0,
      duplicates: 0,
      mediaOnly: 0,
      scoringFailed: 0,
      clickbait: 0,
      belowReadFloor: 0,
      contradicted: 0,
      rankedOut: 0,
      shown: 2,
    };
    const doc = toTimelineDoc({ selected, funnel, settings: { timelineSize: 2 } });
    expect(doc.cards.map((card) => card.post)).toEqual(selected.map(({ post }) => post));
    expect(doc.header.wordCount).toBe(6);
  });
});
