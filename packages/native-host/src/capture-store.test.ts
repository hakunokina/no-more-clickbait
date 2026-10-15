import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionMetricsSchema } from "@nmc/core";
import {
  CaptureStore,
  countShredditPosts,
  defaultCaptureRoot,
  type CaptureSummary,
} from "./capture-store.js";

const SESSION_NOW = "2026-01-01T10:00:00.000Z";

// Fully synthetic HomeTimeline-shaped responses shared with core's tests.
const fixtureBody = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, "..", "..", "core", "fixtures", "x-home-timeline", name),
    "utf8",
  );

// Synthetic body only — modelled on the entryId convention, no real data.
const syntheticBody = (ids: string[]): string =>
  JSON.stringify({ data: { entries: ids.map((entryId) => ({ entryId })) } });

describe("defaultCaptureRoot", () => {
  it("prefers NMC_INBOX_DIR, then %LOCALAPPDATA%\\nmc\\captures", () => {
    expect(defaultCaptureRoot({ NMC_INBOX_DIR: "D:\\inbox", LOCALAPPDATA: "C:\\App" })).toBe(
      "D:\\inbox",
    );
    expect(defaultCaptureRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(
      join("C:\\Users\\x\\AppData\\Local", "nmc", "captures"),
    );
  });
});

describe("CaptureStore", () => {
  let root: string;
  let store: CaptureStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-capture-test-"));
    store = new CaptureStore(root, () => SESSION_NOW);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes raw bodies verbatim into a per-session dir and a counts-only summary", async () => {
    const body1 = syntheticBody(["tweet-1", "tweet-2", "promoted-tweet-3", "cursor-bottom-0"]);
    const body2 = syntheticBody(["tweet-4"]);
    await expect(
      store.store({
        type: "raw-capture",
        operation: "HomeTimeline",
        capturedAt: "2026-01-01T10:00:05.000Z",
        bodyText: body1,
      }),
    ).resolves.toBe(1);
    await expect(
      store.store({
        type: "raw-capture",
        operation: "HomeLatestTimeline",
        capturedAt: "2026-01-01T10:02:35.000Z",
        bodyText: body2,
      }),
    ).resolves.toBe(2);

    const sessionDir = store.sessionDir;
    expect(sessionDir).toBe(join(root, "2026-01-01T10-00-00-000Z"));
    const files = (await readdir(sessionDir ?? "")).sort();
    expect(files).toEqual([
      "0001-2026-01-01T10-00-05-000Z-HomeTimeline.json",
      "0002-2026-01-01T10-02-35-000Z-HomeLatestTimeline.json",
      "summary.json",
    ]);
    await expect(readFile(join(sessionDir ?? "", files[0] ?? ""), "utf8")).resolves.toBe(body1);

    const summary = JSON.parse(
      await readFile(join(sessionDir ?? "", "summary.json"), "utf8"),
    ) as CaptureSummary;
    // summary.json is a valid CollectionMetrics: numbers and times only.
    expect(CollectionMetricsSchema.parse(summary)).toMatchObject({
      firstCapturedAt: "2026-01-01T10:00:05.000Z",
      lastCapturedAt: "2026-01-01T10:02:35.000Z",
      postCount: 3,
      // entryId-only bodies carry no parseable tweets.
      uniquePostCount: 0,
      responseCount: 2,
      promotedCount: 1,
      oversizedCount: 0,
    });
    expect(summary.collectionSpanMs).toBe(150_000);
    expect(store.stats).toEqual({
      responseCount: 2,
      postCount: 3,
      uniquePostCount: 0,
      promotedCount: 1,
      oversizedCount: 0,
    });
  });

  it("counts distinct organic posts across overlapping responses", async () => {
    for (const [index, name] of ["response-1.json", "response-2.json"].entries()) {
      await store.store({
        type: "raw-capture",
        operation: "HomeTimeline",
        capturedAt: `2026-01-01T10:0${index}:00.000Z`,
        bodyText: fixtureBody(name),
      });
    }
    // Response 2 repeats post 1 and re-delivers original 7 via reposts;
    // the ad is dropped. The rough tally counts every tweet- entry.
    expect(store.stats.uniquePostCount).toBe(5);
    expect(store.stats.postCount).toBe(10);
    const summary = JSON.parse(
      await readFile(join(store.sessionDir ?? "", "summary.json"), "utf8"),
    ) as CaptureSummary;
    expect(summary.uniquePostCount).toBe(5);
  });

  it("keeps non-JSON bodies but counts no posts from them", async () => {
    await store.store({
      type: "raw-capture",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:05.000Z",
      bodyText: "not json at all",
    });
    expect(store.stats).toMatchObject({ responseCount: 1, postCount: 0 });
  });

  it("records oversized refusals in the summary without storing a body", async () => {
    await store.recordOversized({
      type: "capture-oversized",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:05.000Z",
      byteLength: 40 * 1024 * 1024,
    });
    const files = await readdir(store.sessionDir ?? "");
    expect(files).toEqual(["summary.json"]);
    expect(store.stats).toMatchObject({ responseCount: 0, oversizedCount: 1 });
    expect(store.summary()).toMatchObject({ oversizedCount: 1, collectionSpanMs: 0 });
  });

  const modeBRun = {
    strategy: "minimized-window",
    counter: "host",
    target: 100,
    startedAt: "2026-01-01T10:00:00.000Z",
    endedAt: "2026-01-01T10:01:00.000Z",
    durationMs: 60_000,
    scrollCount: 8,
    scrollMovedCount: 0,
    hiddenStepCount: 8,
    responseCount: 1,
    uniquePostCount: 4,
    stopReason: "stalled",
  } as const;

  it("adds a Mode B run's counts to the session summary", async () => {
    await store.store({
      type: "raw-capture",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:05.000Z",
      bodyText: fixtureBody("response-1.json"),
    });
    await store.recordModeBRun(modeBRun);
    const summary = JSON.parse(
      await readFile(join(store.sessionDir ?? "", "summary.json"), "utf8"),
    ) as CaptureSummary;
    expect(summary.modeBRun).toEqual(modeBRun);
    expect(summary.uniquePostCount).toBe(4);
    expect(CollectionMetricsSchema.safeParse(summary).success).toBe(true);
  });

  it("writes a run-only summary when the run captured nothing", async () => {
    await store.recordModeBRun({ ...modeBRun, responseCount: 0, stopReason: "not-logged-in" });
    expect(await readdir(store.sessionDir ?? "")).toEqual(["summary.json"]);
    const summary = JSON.parse(
      await readFile(join(store.sessionDir ?? "", "summary.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(summary)).toEqual(["modeBRun"]);
  });
});

// Made-up shreddit markup: invented ids, titles and names, no real data.
const shredditFragment = (ids: string[], ads = 0): string =>
  [
    ...ids.map(
      (id) =>
        `<shreddit-post id="${id}" post-title="Synthetic ${id}" subreddit-prefixed-name="r/example"><div slot="text-body">body</div></shreddit-post>`,
    ),
    ...Array.from(
      { length: ads },
      (_, i) => `<shreddit-ad-post id="ad-${i}"></shreddit-ad-post>`,
    ),
  ].join("\n");

describe("countShredditPosts", () => {
  it("counts post tags, their ids and ad tags in HTML and JSON-escaped bodies", () => {
    expect(countShredditPosts(shredditFragment(["t3_a", "t3_b"], 1))).toEqual({
      postIds: ["t3_a", "t3_b"],
      postTags: 2,
      adTags: 1,
    });
    expect(countShredditPosts(JSON.stringify({ html: shredditFragment(["t3_c"]) }))).toEqual({
      postIds: ["t3_c"],
      postTags: 1,
      adTags: 0,
    });
    // Look-alike tags and attributes are not posts / ids.
    expect(
      countShredditPosts(
        '<shreddit-post-overflow id="x"></shreddit-post-overflow><shreddit-post author-id="t2_z">',
      ),
    ).toEqual({ postIds: [], postTags: 1, adTags: 0 });
  });
});

describe("CaptureStore for Reddit", () => {
  let root: string;
  let store: CaptureStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-capture-test-"));
    store = new CaptureStore(root, () => SESSION_NOW, "reddit");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes into its own folder and counts distinct shreddit-post ids per path", async () => {
    const capture = (operation: string, bodyText: string, second: number) =>
      store.store({
        type: "raw-capture",
        source: "reddit",
        operation,
        capturedAt: `2026-01-01T10:00:0${second}.000Z`,
        bodyText,
      });
    await capture("dom-initial", shredditFragment(["t3_1", "t3_2"], 1), 1);
    // The next page overlaps by one post; one JSON body carries none.
    await capture(
      "/svc/shreddit/community-more-posts/hot/",
      shredditFragment(["t3_2", "t3_3"]),
      2,
    );
    await capture("gql.reddit.com/", '{"data":{}}', 3);

    const sessionDir = store.sessionDir ?? "";
    expect(sessionDir).toBe(join(root, "2026-01-01T10-00-00-000Z-reddit"));
    expect((await readdir(sessionDir)).sort()).toEqual([
      "0001-2026-01-01T10-00-01-000Z-dom-initial.html",
      "0002-2026-01-01T10-00-02-000Z-_svc_shreddit_community-more-posts_hot_.html",
      "0003-2026-01-01T10-00-03-000Z-gql_reddit_com_.json",
      "summary.json",
    ]);
    expect(store.stats).toEqual({
      responseCount: 3,
      postCount: 4,
      uniquePostCount: 3,
      promotedCount: 1,
      oversizedCount: 0,
    });
    const summary = JSON.parse(
      await readFile(join(sessionDir, "summary.json"), "utf8"),
    ) as CaptureSummary;
    expect(CollectionMetricsSchema.parse(summary)).toMatchObject({ uniquePostCount: 3 });
    expect(summary.source).toBe("reddit");
    expect(summary.paths).toEqual({
      "dom-initial": { responses: 1, json: 0, html: 1, other: 0 },
      "/svc/shreddit/community-more-posts/hot/": { responses: 1, json: 0, html: 1, other: 0 },
      "gql.reddit.com/": { responses: 1, json: 1, html: 0, other: 0 },
    });
  });
});

// Fully synthetic Instagram feed bodies shared with core's tests.
const instagramFixture = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, "..", "..", "core", "fixtures", "instagram-feed", name),
    "utf8",
  );

describe("CaptureStore for Instagram", () => {
  let root: string;
  let store: CaptureStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-capture-test-"));
    store = new CaptureStore(root, () => SESSION_NOW, "instagram");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses the feed, counts distinct organic posts and the caption-less share", async () => {
    const capture = (operation: string, bodyText: string, second: number) =>
      store.store({
        type: "raw-capture",
        source: "instagram",
        operation,
        capturedAt: `2026-01-01T10:00:0${second}.000Z`,
        bodyText,
      });
    await capture("ssr", instagramFixture("ssr-block.json"), 1);
    // The next page repeats one post; a wrong-endpoint answer has a null root.
    await capture("graphql-query", instagramFixture("graphql-page-2.txt"), 2);
    await capture("graphql-query", instagramFixture("graphql-null-root.json"), 3);

    const sessionDir = store.sessionDir ?? "";
    expect(sessionDir).toBe(join(root, "2026-01-01T10-00-00-000Z-instagram"));
    expect((await readdir(sessionDir)).sort()).toEqual([
      "0001-2026-01-01T10-00-01-000Z-ssr.json",
      "0002-2026-01-01T10-00-02-000Z-graphql-query.json",
      "0003-2026-01-01T10-00-03-000Z-graphql-query.json",
      "summary.json",
    ]);
    expect(store.stats).toEqual({
      responseCount: 3,
      postCount: 9,
      uniquePostCount: 7,
      promotedCount: 1,
      oversizedCount: 0,
    });
    const summary = JSON.parse(
      await readFile(join(sessionDir, "summary.json"), "utf8"),
    ) as CaptureSummary;
    expect(CollectionMetricsSchema.parse(summary)).toMatchObject({ uniquePostCount: 7 });
    expect(summary.source).toBe("instagram");
    expect(summary.paths).toEqual({
      ssr: { responses: 1, json: 1, html: 0, other: 0 },
      "graphql-query": { responses: 2, json: 2, html: 0, other: 0 },
    });
    expect(summary.instagram).toEqual({
      responsesWithFeed: 2,
      edges: 16,
      slots: {
        media: 8,
        explore_story: 2,
        ad: 1,
        end_of_feed_demarcator: 1,
        stories_netego: 1,
        suggested_users: 1,
        bloks_netego: 0,
        abra_icebreakers_in_feed_unit: 0,
        ad4ad_in_webfeed: 0,
        unknown: 1,
        empty: 1,
      },
      skipped: { "invalid-media": 1, repeated: 1 },
      kept: 7,
      kinds: { post: 5, reel: 1, carousel: 1 },
      suggested: 2,
      captionless: 2,
      shortCaption: 1,
      captionlessRatio: 0.286,
      captionlessOrShortRatio: 0.429,
    });
    // Counts only: no handle, caption or media id reaches the summary.
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/example_|Synthetic|3100000000|SYNTH/);
  });
});
