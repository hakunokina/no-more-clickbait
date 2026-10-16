import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  feedItemKey,
  platformOf,
  SettingsSchema,
  type CollectSourceOutcome,
  type FeedBatch,
  type FeedItem,
  type GenericItem,
  type InstagramPost,
  type Post,
  type PostBatch,
  type SiteCollectOutcome,
} from "@nmc/core";
import { listSessions, PostSessionStore, type DesktopCommand } from "@nmc/native-host";
import { renderTimeline, TIMELINE_CSPS } from "@nmc/timeline-renderer";
import { describeRun } from "../shared/format.js";
import { messages, note, say } from "../shared/i18n.js";
import type { DesktopStatus } from "../shared/status.js";
import { PipelineRunner, type RunStages } from "./pipeline-runner.js";
import {
  collectedCount,
  missingSourcesOf,
  planCompletion,
  runSourcesOf,
  SessionController,
  TIMELINE_DOC_FILE,
  TIMELINE_FILE,
  type SessionControllerDeps,
} from "./session-controller.js";

// Fully synthetic posts — no real feed data.
function post(id: string): Post {
  return {
    id,
    source: "x-home-timeline",
    authorHandle: "synthetic",
    text: `synthetic post ${id}`,
    url: `https://x.com/synthetic/status/${id}`,
    publishedAt: "2026-01-01T09:00:00.000Z",
    media: [],
    promoted: false,
  };
}

function batch(ids: string[]): PostBatch {
  return {
    source: "x-home-timeline",
    capturedAt: "2026-01-01T10:00:01.000Z",
    posts: ids.map(post),
  };
}

function genericItem(id: string): GenericItem {
  return {
    platform: "generic",
    id,
    sourceLabel: "custom:News",
    title: `synthetic headline ${id}`,
    url: `https://news.example/world/${id}`,
    domain: "news.example",
    kind: "link",
    promoted: false,
  };
}

function instagramPost(id: string): InstagramPost {
  return {
    platform: "instagram",
    id,
    url: `https://www.instagram.com/p/${id}/`,
    authorHandle: "synthetic_ig",
    caption: `synthetic caption ${id}`,
    kind: "post",
    media: [],
    publishedAt: "2026-01-01T08:00:00.000Z",
    promoted: false,
  };
}

function feedBatch(siteId: string, items: FeedItem[]): FeedBatch {
  return { siteId, capturedAt: "2026-01-01T10:00:02.000Z", items };
}

/** X + two custom sites, the second broken: its outcome only, no items. */
const SITES: SiteCollectOutcome[] = [
  { siteId: "news.example/world", name: "News", status: "ok", method: "rss", itemCount: 2 },
  {
    siteId: "broken.example/feed",
    name: "Broken News",
    status: "error",
    method: "static",
    itemCount: 0,
  },
];

function stages(overrides: Partial<RunStages> = {}): RunStages {
  return {
    checkAvailable: async () => ({ ok: true, version: "fake" }),
    scorer: {
      score: async (posts) =>
        posts.map((p) => ({
          postId: p.id,
          clickbaitScore: 0.1,
          readWorthinessScore: 0.6,
          checkWorthy: false,
          checkWorthyClaim: null,
        })),
    },
    verifier: { verify: async () => Promise.reject(new Error("not expected")) },
    cancel() {},
    ...overrides,
  };
}

async function completeSession(
  root: string,
  at: string,
  ids: string[],
  mode: "A" | "B" = "B",
): Promise<string> {
  const store = new PostSessionStore(root, () => at);
  await store.addBatch(batch(ids));
  return (await store.complete({
    mode,
    reason: "target-reached",
    uniquePostCount: ids.length,
    responseCount: 1,
  })) as string;
}

describe("missingSourcesOf", () => {
  const x = { label: "x", reason: "nothingFromSource" } as const;
  const site = { label: "site.example/a", reason: "siteTimeout" } as const;

  it("lists enabled sources that delivered nothing while others did, with their reason", () => {
    const delivered = [{ label: "x", in: 4, shown: 2 }];
    expect(missingSourcesOf([x, site], delivered)).toEqual([
      { label: "site.example/a", reason: messages("en").siteTimeout },
    ]);
    expect(missingSourcesOf([x, site], delivered, "tr")).toEqual([
      { label: "site.example/a", reason: messages("tr").siteTimeout },
    ]);
    expect(missingSourcesOf([x], delivered)).toEqual([]);
    expect(missingSourcesOf([x, site, site], [{ label: "custom:B", in: 1, shown: 1 }])).toEqual(
      [
        { label: "x", reason: messages("en").nothingFromSource },
        { label: "site.example/a", reason: messages("en").siteTimeout },
      ],
    );
  });

  it("lists nothing when no source delivered (not a partial timeline)", () => {
    expect(missingSourcesOf([x, site], undefined)).toEqual([]);
    expect(missingSourcesOf([x], [])).toEqual([]);
  });
});

describe("runSourcesOf", () => {
  it("is X alone without custom sites (older sessions too)", () => {
    expect(runSourcesOf(undefined, [])).toEqual([{ label: "x", reason: "nothingFromSource" }]);
  });

  it("expects each site that stored nothing by its rule name, with its outcome as the reason", () => {
    expect(runSourcesOf(SITES, ["news.example/world"])).toEqual([
      { label: "x", reason: "nothingFromSource" },
      // bySource's vocabulary: the label its items would have had.
      { label: "custom:Broken News", reason: "siteError" },
    ]);
  });

  it("expects each scrolled feed by its label, with its stop as the reason", () => {
    const feeds: CollectSourceOutcome[] = [
      { source: "x", uniquePostCount: 0, reason: "not-logged-in", target: 100 },
      { source: "instagram", uniquePostCount: 0, reason: "stalled", target: 100 },
    ];
    expect(runSourcesOf(undefined, [], feeds)).toEqual([
      { label: "x", reason: "sourceNotLoggedInX" },
      { label: "instagram", reason: "sourceStalled" },
    ]);
    // Instagram alone: X is not expected at all.
    expect(
      runSourcesOf(
        undefined,
        [],
        [{ source: "instagram", uniquePostCount: 0, reason: "not-logged-in" }],
      ),
    ).toEqual([{ label: "instagram", reason: "sourceNotLoggedInInstagram" }]);
    // Custom sites alone (`[]`): neither feed is expected.
    expect(runSourcesOf(SITES, ["news.example/world"], [])).toEqual([
      { label: "custom:Broken News", reason: "siteError" },
    ]);
    expect(
      missingSourcesOf(runSourcesOf(undefined, [], feeds), [
        { label: "instagram", in: 3, shown: 2 },
      ]),
    ).toEqual([{ label: "x", reason: "Not logged in to X in this browser." }]);
  });

  it("falls back to the site id when an older extension sent no name", () => {
    const sites: SiteCollectOutcome[] = [
      { siteId: "news.example/world", status: "ok", method: "rss", itemCount: 2 },
      { siteId: "broken.example/feed", status: "error", method: "static", itemCount: 0 },
      { siteId: "slow.example", status: "timeout", itemCount: 0 },
      { siteId: "quiet.example", status: "empty", itemCount: 0 },
      { siteId: "note.example", status: "skipped", itemCount: 0 },
      { siteId: "lost.example", status: "ok", itemCount: 3 },
    ];
    expect(runSourcesOf(sites, ["news.example/world"])).toEqual([
      { label: "x", reason: "nothingFromSource" },
      { label: "broken.example/feed", reason: "siteError" },
      { label: "slow.example", reason: "siteTimeout" },
      { label: "quiet.example", reason: "siteEmpty" },
      { label: "note.example", reason: "siteSkipped" },
      // Collected, but nothing reached the session.
      { label: "lost.example", reason: "nothingFromSource" },
    ]);
  });
});

describe("planCompletion over several feeds", () => {
  const feed = (source: "x" | "instagram", reason: string, count = 10) => ({
    source,
    uniquePostCount: count,
    reason,
    target: 100,
  });

  it("builds when any feed ended normally: one feed not logged in does not hold the other", () => {
    expect(
      planCompletion("B", "not-logged-in", [
        feed("x", "not-logged-in", 0),
        feed("instagram", "target-reached"),
      ]),
    ).toBe("build");
    expect(
      planCompletion("B", "not-logged-in", [
        feed("x", "target-reached"),
        feed("instagram", "not-logged-in", 0),
      ]),
    ).toBe("build");
    expect(
      planCompletion("B", "not-logged-in", [
        feed("x", "not-logged-in", 0),
        feed("instagram", "not-logged-in", 0),
      ]),
    ).toBe("ask");
  });

  it("lets a stop of the whole run decide alone; Mode A always asks", () => {
    const fine = [feed("x", "target-reached"), feed("instagram", "cancelled")];
    expect(planCompletion("B", "cancelled", fine)).toBe("drop");
    expect(planCompletion("B", "tab-closed", fine)).toBe("ask");
    expect(planCompletion("A", "target-reached", fine)).toBe("ask");
    // Custom sites alone, collected at once.
    expect(planCompletion("B", "sites-collected", [])).toBe("build");
  });

  it("counts every feed's posts together, X's alone otherwise", () => {
    expect(
      collectedCount(7, [feed("x", "target-reached", 7), feed("instagram", "stalled", 5)]),
    ).toBe(12);
    expect(collectedCount(7, undefined)).toBe(7);
    expect(collectedCount(0, [])).toBe(0);
  });
});

describe("SessionController", () => {
  let root: string;
  let statuses: DesktopStatus[];
  let ready: { sessionId: string; timelinePath: string; selected: number }[];
  let asked: { sessionId: string; uniquePostCount: number }[];
  let sent: DesktopCommand[];
  let hostOnline: boolean;
  let runStages: RunStages;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-controller-test-"));
    statuses = [];
    ready = [];
    asked = [];
    sent = [];
    hostOnline = true;
    runStages = stages();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(
    settingsReady: Promise<unknown> = Promise.resolve(),
    extra: Partial<SessionControllerDeps> = {},
  ): SessionController {
    return new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => {
        await settingsReady;
        return SettingsSchema.parse({ collectTarget: 120 });
      },
      renderTimeline: (doc) => `<p>${doc.cards.length} posts</p>`,
      sendToHost: (command) => {
        if (!hostOnline) return false;
        sent.push(command);
        return true;
      },
      onStatus: (status) => statuses.push(status),
      onReady: (info) => ready.push(info),
      onAwaitingConfirmation: (pending) => asked.push(pending),
      now: () => "2026-01-01T12:00:00.000Z",
      ...extra,
    });
  }

  /** A finished Mode B collection on disk, ended for `reason`. */
  async function stoppedSession(reason: string, uniquePostCount: number): Promise<string> {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addBatch(batch(["1", "2", "3"]));
    return (await store.complete({
      mode: "B",
      reason,
      uniquePostCount,
      responseCount: 3,
      target: 100,
    })) as string;
  }

  function completeEvent(sessionId: string, reason: string, uniquePostCount: number) {
    return {
      type: "collection-complete" as const,
      sessionId,
      mode: "B" as const,
      reason,
      uniquePostCount,
      responseCount: 3,
      target: 100,
    };
  }

  it("asks the newest host to collect, with the settings' target", async () => {
    const c = controller();
    await c.startCollection();
    expect(sent).toEqual([{ type: "start-collection", target: 120 }]);
    expect(c.status.collection).toMatchObject({ state: "requested", target: 120 });

    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    expect(c.status.collection.state).toBe("collecting");
  });

  it("says so when the browser/extension is not there", async () => {
    hostOnline = false;
    const c = controller();
    await c.startCollection();
    expect(c.status.collection.state).toBe("refused");
    expect(say("en", c.status.collection.message)).toMatch(
      /browser or the extension is not running/,
    );
  });

  it("relays the Mode B off instruction", () => {
    const c = controller();
    c.handleHostEvent({ type: "collection-start-result", outcome: "mode-b-off", target: 250 });
    expect(c.status.collection.state).toBe("refused");
    expect(say("en", c.status.collection.message)).toMatch(/Browse x\.com\/home/);
  });

  it("runs a completed collection and writes the timeline", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2", "2"]);
    const c = controller();
    await c.runSession(id);

    expect(c.status.run).toMatchObject({ stage: "ready", sessionId: id, hasTimeline: true });
    expect(c.status.run.counts).toMatchObject({ postsIn: 3, afterHardFilter: 2, selected: 2 });
    expect(ready).toEqual([
      { sessionId: id, timelinePath: join(root, id, TIMELINE_FILE), selected: 2 },
    ]);
    await expect(readFile(join(root, id, TIMELINE_FILE), "utf8")).resolves.toBe(
      "<p>2 posts</p>",
    );
    const doc = JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
      funnel: { scanned: number; duplicates: number; shown: number };
      bySource?: unknown;
      missingSources?: unknown;
    };
    expect(doc.funnel).toMatchObject({ scanned: 3, duplicates: 1, shown: 2 });
    expect(doc.bySource).toEqual([{ label: "x", in: 3, shown: 2 }]);
    expect(doc).not.toHaveProperty("missingSources");
    expect(c.status.run.funnel).toMatchObject({ scanned: 3, shown: 2 });
    const [session] = await listSessions(root);
    expect(session?.processed?.status).toBe("done");
    const stages = statuses.map((s) => s.run.stage);
    expect(stages).toContain("scoring");
    expect(stages.at(-1)).toBe("ready");
  });

  it("writes the real renderer's page, with the desktop's action buttons", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2"]);
    const c = new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => SettingsSchema.parse({ timelineSize: 2 }),
      renderTimeline: (doc) => renderTimeline(doc, { actions: true }),
      sendToHost: () => false,
      onStatus: () => {},
      onReady: () => {},
    });
    await c.runSession(id);
    const html = await readFile(join(root, id, TIMELINE_FILE), "utf8");
    expect(html).toContain(TIMELINE_CSPS.en);
    expect(html).toContain('data-action="collect"');
    expect(html).toContain("synthetic post 1");
  });

  /** X posts plus two custom sites (one broken), completed as a Mode B run. */
  async function mixedSession(xIds: string[] = ["1", "2"]): Promise<string> {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    if (xIds.length > 0) await store.addBatch(batch(xIds));
    await store.addFeedBatch(
      feedBatch("news.example/world", [genericItem("g1"), instagramPost("ig1")]),
    );
    const reason = xIds.length > 0 ? "target-reached" : "stalled";
    return (await store.complete({
      mode: "B",
      reason,
      uniquePostCount: xIds.length,
      responseCount: 1,
      target: 100,
      sites: SITES,
      // Instagram's items are in the run only when it was collected.
      sources: [
        { source: "x", uniquePostCount: xIds.length, reason, target: 100 },
        { source: "instagram", uniquePostCount: 1, reason: "stalled", target: 100 },
      ],
    })) as string;
  }

  /** The real renderer, and a scorer that keys every item like the pipeline. */
  function mixedController(judged: FeedItem[][]): SessionController {
    runStages = stages({
      scorer: {
        score: async (items) => {
          judged.push([...items]);
          return items.map((item) => ({
            postId: feedItemKey(item),
            clickbaitScore: 0.1,
            readWorthinessScore: 0.6,
            checkWorthy: false,
            checkWorthyClaim: null,
          }));
        },
      },
    });
    return controller(undefined, {
      loadSettings: async () => SettingsSchema.parse({ timelineSize: 10 }),
      renderTimeline: (doc, lang) => renderTimeline(doc, { actions: true, lang }),
    });
  }

  it("runs X and the custom sites' items together; a broken site is named as missing", async () => {
    const id = await mixedSession();
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    await c.processPending(); // complete.json on disk carries the sites' outcomes

    expect(c.status.run.stage).toBe("ready");
    expect(judged.flat().map((item) => `${platformOf(item)}:${item.id}`)).toEqual([
      "x:1",
      "x:2",
      "generic:g1",
      "instagram:ig1",
    ]);
    const doc = JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
      bySource: { label: string; in: number; shown: number }[];
      missingSources: { label: string; reason: string }[];
      cards: unknown[];
    };
    expect(doc.cards).toHaveLength(4);
    expect(doc.bySource).toEqual(
      expect.arrayContaining([
        { label: "x", in: 2, shown: 2 },
        { label: "custom:News", in: 1, shown: 1 },
        { label: "instagram", in: 1, shown: 1 },
      ]),
    );
    expect(doc.bySource).toHaveLength(3);
    expect(doc.missingSources).toEqual([
      { label: "custom:Broken News", reason: messages("en").siteError },
    ]);

    const page = () => readFile(join(root, id, TIMELINE_FILE), "utf8");
    const html = await page();
    expect(html).toContain('<article class="post" ');
    expect(html).toContain('<article class="post post--ig" ');
    expect(html).toContain('<article class="post post--gen" ');
    // The page drops the reason's own full stop inside the brackets (#2125).
    expect(html).toContain(`Broken News (${messages("en").siteError.replace(/\.$/, "")})`);
    expect(html).not.toContain("broken.example/feed");

    // The broken site's note follows the language, with its own reason.
    await expect(c.setLang("tr")).resolves.toBe(true);
    expect(await page()).toContain(`(${messages("tr").siteError.replace(/\.$/, "")})`);
    expect(await page()).not.toContain(messages("tr").nothingFromSource);
  });

  it("keeps the X numbers to X: the pending count and the stored batch count", async () => {
    const id = await mixedSession();
    const c = controller();
    c.handleHostEvent({ ...completeEvent(id, "not-logged-in", 2), sites: SITES });
    await expect.poll(() => c.status.pending?.uniquePostCount).toBe(2);
    expect(asked).toEqual([{ sessionId: id, uniquePostCount: 2 }]);
    const [session] = await listSessions(root);
    expect(session).toMatchObject({ batchCount: 1, feedBatchCount: 1 });
  });

  it("builds a run whose X part brought nothing but a site did", async () => {
    const id = await mixedSession([]);
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent({ ...completeEvent(id, "stalled", 0), sites: SITES });
    await expect.poll(() => c.status.run.stage).toBe("ready");
    expect(judged.flat().map(platformOf)).toEqual(["generic", "instagram"]);
    const doc = JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
      missingSources: { label: string }[];
    };
    expect(doc.missingSources.map((source) => source.label)).toEqual([
      "x",
      "custom:Broken News",
    ]);
  });

  it("still drops a run where neither X nor any site brought anything", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch(feedBatch("news.example/world", []));
    const id = (await store.complete({
      mode: "B",
      reason: "stalled",
      uniquePostCount: 0,
      responseCount: 1,
      sites: [{ siteId: "news.example/world", status: "empty", itemCount: 0 }],
    })) as string;
    const c = controller();
    await c.processPending();
    expect(c.status.run.stage).toBe("idle");
    expect((await listSessions(root)).find((s) => s.id === id)?.processed?.status).toBe(
      "cancelled",
    );
  });

  it("drops a run whose site said it delivered items but stored none, without running", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch(feedBatch("lost.example", []));
    const sites: SiteCollectOutcome[] = [
      { siteId: "lost.example", status: "ok", itemCount: 3 },
    ];
    const id = (await store.complete({
      mode: "B",
      reason: "stalled",
      uniquePostCount: 0,
      responseCount: 1,
      sites,
    })) as string;
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent({ ...completeEvent(id, "stalled", 0), sites });
    await expect
      .poll(async () => (await listSessions(root)).find((s) => s.id === id)?.processed?.status)
      .toBe("cancelled");
    expect(judged).toEqual([]);
    expect(ready).toEqual([]);
    expect(c.status.run.stage).toBe("idle");
    expect(c.status.collection.message).toEqual(note("endedEmpty", "stalled"));
  });

  /** Mode A ended by turning both ticks off: the feeds named nothing (`sources: []`). */
  async function ticksOffSession(feedItems: FeedItem[]): Promise<string> {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch(feedBatch("instagram", [instagramPost("ig1")]));
    if (feedItems.length > 0)
      await store.addFeedBatch(feedBatch("news.example/world", feedItems));
    return (await store.complete({
      mode: "A",
      reason: "finished-early",
      uniquePostCount: 0,
      responseCount: 1,
      sources: [],
    })) as string;
  }

  function ticksOffEvent(id: string) {
    return { ...completeEvent(id, "finished-early", 0), mode: "A" as const, sources: [] };
  }

  it("drops a run whose only items are a feed turned off, without running", async () => {
    const id = await ticksOffSession([]);
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent(ticksOffEvent(id));
    await expect
      .poll(async () => (await listSessions(root)).find((s) => s.id === id)?.processed?.status)
      .toBe("cancelled");
    expect(c.status.pending).toBeNull();
    expect(judged).toEqual([]);
    expect(c.status.run.stage).toBe("idle");
  });

  it("keeps a run with every feed turned off pending on its custom sites' items alone", async () => {
    const id = await ticksOffSession([genericItem("g1"), genericItem("g2")]);
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent(ticksOffEvent(id));
    await expect.poll(() => c.status.pending?.sessionId).toBe(id);
    // The sites' items are what the run judges: counted, not "0 posts".
    expect(c.status.pending).toMatchObject({ uniquePostCount: 2, sources: [] });
    expect(judged).toEqual([]);
    await c.buildPending();
    expect(c.status.run.stage).toBe("ready");
    expect(judged.flat().map((item) => `${platformOf(item)}:${item.id}`)).toEqual([
      "generic:g1",
      "generic:g2",
    ]);
  });

  it("counts the custom sites' items when X alone gave no posts", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch(
      feedBatch("news.example/world", [genericItem("g1"), genericItem("g2")]),
    );
    const id = (await store.complete({
      mode: "A",
      reason: "finished-early",
      uniquePostCount: 0,
      responseCount: 1,
    })) as string;
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent({ ...completeEvent(id, "finished-early", 0), mode: "A" as const });
    await expect.poll(() => c.status.pending?.sessionId).toBe(id);
    expect(c.status.pending).toMatchObject({ uniquePostCount: 2 });
  });

  it("names a site that said it delivered items but stored none as missing", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addBatch(batch(["1", "2"]));
    const id = (await store.complete({
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 2,
      responseCount: 1,
      target: 100,
      sites: [{ siteId: "lost.example", status: "ok", itemCount: 3 }],
    })) as string;
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    await c.processPending();
    expect(c.status.run.stage).toBe("ready");
    expect(judged.flat().map((item) => `${platformOf(item)}:${item.id}`)).toEqual([
      "x:1",
      "x:2",
    ]);
    const doc = JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
      missingSources: { label: string; reason: string }[];
    };
    expect(doc.missingSources).toEqual([
      { label: "lost.example", reason: messages("en").nothingFromSource },
    ]);
  });

  it("writes the timeline in the windows' language, and again when it changes", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2"]);
    const c = new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => SettingsSchema.parse({ timelineSize: 2 }),
      renderTimeline: (doc, lang) => renderTimeline(doc, { actions: true, lang }),
      sendToHost: () => false,
      onStatus: () => {},
      onReady: () => {},
    });
    await expect(c.setLang("tr")).resolves.toBe(false); // no timeline yet
    expect(c.status.lang).toBe("tr");
    await c.runSession(id);
    const page = () => readFile(join(root, id, TIMELINE_FILE), "utf8");
    expect(await page()).toContain('<html lang="tr">');
    expect(await page()).toContain(TIMELINE_CSPS.tr);

    await expect(c.setLang("en")).resolves.toBe(true);
    expect(c.status.lang).toBe("en");
    expect(await page()).toContain('<html lang="en">');
    expect(await page()).toContain("synthetic post 1");
    await expect(c.setLang("en")).resolves.toBe(false); // unchanged
  });

  it("ends quick language changes in the last one, one rewrite at a time", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2"]);
    const rendered: string[] = [];
    const rewritten: string[] = [];
    let backToEn: Promise<boolean> | null = null;
    const c: SessionController = new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => SettingsSchema.parse({ timelineSize: 2 }),
      renderTimeline: (doc, lang) => {
        rendered.push(lang);
        // The user switches back while the Turkish page is being made.
        if (lang === "tr" && !backToEn) backToEn = c.setLang("en");
        return renderTimeline(doc, { actions: true, lang });
      },
      sendToHost: () => false,
      onStatus: () => {},
      onReady: () => {},
      onTimelineRewritten: (path) => rewritten.push(path),
    });
    await c.runSession(id);
    const page = () => readFile(join(root, id, TIMELINE_FILE), "utf8");
    rendered.length = 0;

    // en→tr, and back to en while the Turkish page is being made: it is
    // not written over the (English) page.
    await expect(c.setLang("tr")).resolves.toBe(false);
    await expect(backToEn).resolves.toBe(false);
    expect(rendered).toEqual(["tr"]);
    expect(await page()).toContain('<html lang="en">');
    expect(rewritten).toEqual([]);

    // en→tr→en→tr at once: one rewrite, in the last language.
    const results = await Promise.all([c.setLang("tr"), c.setLang("en"), c.setLang("tr")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await page()).toContain('<html lang="tr">');
    expect(rewritten).toEqual([join(root, id, TIMELINE_FILE)]);
  });

  it("rewrites the open timeline when the language changed during a run", async () => {
    const first = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2"]);
    const second = await completeSession(root, "2026-01-01T11:00:00.000Z", ["3"]);
    const rewritten: string[] = [];
    const c = new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => SettingsSchema.parse({ timelineSize: 2 }),
      renderTimeline: (doc, lang) => renderTimeline(doc, { actions: true, lang }),
      sendToHost: () => false,
      onStatus: () => {},
      onReady: () => {},
      onTimelineRewritten: (path) => rewritten.push(path),
    });
    await c.runSession(first);
    const page = () => readFile(join(root, first, TIMELINE_FILE), "utf8");

    // The next run fails, and the language changes while it runs.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    runStages = stages({
      checkAvailable: async () => {
        await gate;
        return { ok: false, reason: "not-found", detail: "ENOENT" };
      },
    });
    const run = c.runSession(second);
    await expect(c.setLang("tr")).resolves.toBe(false); // busy: left for later
    expect(await page()).toContain('<html lang="en">');

    release();
    await run;
    expect(c.status.run.stage).toBe("error");
    // The earlier timeline, still the one to open, follows the language.
    await expect.poll(() => rewritten).toEqual([join(root, first, TIMELINE_FILE)]);
    expect(await page()).toContain('<html lang="tr">');
  });

  it("starts the run from a host's Mode B collection-complete event", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    const c = controller();
    c.handleHostEvent({
      type: "collection-complete",
      sessionId: id,
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 1,
      responseCount: 1,
    });
    await expect.poll(() => c.status.run.stage).toBe("ready");
  });

  it("processes the newest pending session at start-up and supersedes older ones", async () => {
    const older = await completeSession(root, "2026-01-01T09:00:00.000Z", ["1"]);
    const newer = await completeSession(root, "2026-01-01T10:00:00.000Z", ["2"]);
    const c = controller();
    await c.processPending();
    expect(ready.map((r) => r.sessionId)).toEqual([newer]);
    const byId = Object.fromEntries(
      (await listSessions(root)).map((s) => [s.id, s.processed?.status]),
    );
    expect(byId).toEqual({ [older]: "superseded", [newer]: "done" });
    await c.processPending();
    expect(ready).toHaveLength(1);
  });

  it("never runs a Mode A collection without the user's go", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2"], "A");
    const c = controller();
    c.handleHostEvent({
      type: "collection-complete",
      sessionId: id,
      mode: "A",
      reason: "target-reached",
      uniquePostCount: 2,
      responseCount: 1,
    });
    await expect
      .poll(() => c.status.pending)
      .toEqual({
        sessionId: id,
        uniquePostCount: 2,
        mode: "A",
        reason: "target-reached",
        target: null,
      });
    expect(asked).toEqual([{ sessionId: id, uniquePostCount: 2 }]);
    expect(c.status.run.stage).toBe("idle");
    expect((await listSessions(root))[0]?.processed).toBeNull();

    await c.buildPending();
    expect(c.status.pending).toBeNull();
    expect(c.status.run.stage).toBe("ready");
    expect(ready.map((r) => r.sessionId)).toEqual([id]);
  });

  it("keeps a Mode A session pending across restarts, without asking again", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"], "A");
    const c = controller();
    await c.processPending();
    expect(c.status.pending).toMatchObject({ sessionId: id, uniquePostCount: 1, mode: "A" });
    expect(c.status.run.stage).toBe("idle");
    expect(asked).toEqual([]);
    await c.processPending();
    expect(ready).toEqual([]);
  });

  it("lets a newer collection supersede a pending one", async () => {
    const older = await completeSession(root, "2026-01-01T09:00:00.000Z", ["1"], "A");
    const newer = await completeSession(root, "2026-01-01T10:00:00.000Z", ["2"], "A");
    const c = controller();
    for (const sessionId of [older, newer]) {
      c.handleHostEvent({
        type: "collection-complete",
        sessionId,
        mode: "A",
        reason: "target-reached",
        uniquePostCount: 1,
        responseCount: 1,
      });
      await expect.poll(() => c.status.pending?.sessionId).toBe(sessionId);
    }
    const byId = Object.fromEntries(
      (await listSessions(root)).map((s) => [s.id, s.processed?.status ?? null]),
    );
    expect(byId).toEqual({ [older]: "superseded", [newer]: null });
  });

  it("marks a failed run on disk, never re-runs it, and retries on request", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    let checks = 0;
    runStages = stages({
      checkAvailable: async () => {
        checks += 1;
        return { ok: false, reason: "not-found", detail: "ENOENT" };
      },
    });
    const c = controller();
    await c.processPending();
    expect(c.status.run.stage).toBe("error");
    expect(c.status.run.error?.kind).toBe("cli-not-found");
    expect((await listSessions(root))[0]?.processed).toMatchObject({
      status: "error",
      error: { kind: "cli-not-found", note: "errCliNotFound" },
    });

    // Not retried automatically (no error loop on every host reconnect)...
    const before = statuses.length;
    await c.processPending();
    expect(statuses).toHaveLength(before);

    // ...nor at the next app start: the error is shown for "Try again".
    const restarted = controller();
    await restarted.processPending();
    expect(checks).toBe(1);
    expect(restarted.status.run).toMatchObject({
      stage: "error",
      sessionId: id,
      // Saved in English, read back as its note: shown in either language.
      error: { kind: "cli-not-found", note: { key: "errCliNotFound" }, detail: null },
    });

    // "Try again" runs it, without collecting again.
    runStages = stages();
    await restarted.retry();
    expect(restarted.status.run.stage).toBe("ready");
    expect(ready.map((r) => r.sessionId)).toEqual([id]);
    expect((await listSessions(root))[0]?.processed?.status).toBe("done");
  });

  it("cancels while the session is still being read back, before the runner starts", async () => {
    let checks = 0;
    runStages = stages({
      checkAvailable: async () => {
        checks += 1;
        return { ok: true, version: "fake" };
      },
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    const c = controller(gate);
    const running = c.runSession(id);
    expect(c.status.run.stage).toBe("checking");
    expect(c.cancel()).toBe(true);
    release();
    await running;
    expect(checks).toBe(0);
    expect(c.status.run.stage).toBe("cancelled");
    expect((await listSessions(root)).find((s) => s.id === id)?.processed?.status).toBe(
      "cancelled",
    );
    expect(ready).toEqual([]);

    // The flag does not leak into the next run.
    await c.retry();
    expect(c.status.run.stage).toBe("ready");
  });

  it("says the timeline is gone when its session folder was pruned", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    let renders = 0;
    const c = controller(undefined, {
      renderTimeline: (doc) => {
        renders += 1;
        return `<p>${doc.cards.length} posts</p>`;
      },
    });
    await c.runSession(id);
    expect(await c.availableTimeline()).toBe(join(root, id, TIMELINE_FILE));
    await rm(join(root, id), { recursive: true, force: true });
    expect(await c.availableTimeline()).toBeNull();
    expect(c.status.run).toMatchObject({
      stage: "ready",
      hasTimeline: false,
      timelineGone: true,
    });
    expect(c.timelinePath).toBeNull();
    // Nothing is left to re-word: a language change renders no page.
    const rendered = renders;
    await expect(c.setLang("tr")).resolves.toBe(false);
    expect(renders).toBe(rendered);
  });

  it("runs one session at a time and queues the next", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = stages();
    runStages = stages({
      scorer: {
        score: async (posts) => {
          await gate;
          return base.scorer.score(posts);
        },
      },
    });
    const first = await completeSession(root, "2026-01-01T09:00:00.000Z", ["1"]);
    const second = await completeSession(root, "2026-01-01T10:00:00.000Z", ["2"]);
    const c = controller();
    const running = c.runSession(first);
    await expect.poll(() => c.status.run.stage).toBe("scoring");
    await c.runSession(second);
    expect(c.status.run.sessionId).toBe(first);
    await c.startCollection();
    expect(sent).toEqual([]);
    expect(say("en", c.status.collection.message)).toMatch(/being prepared/);
    release();
    await running;
    await expect.poll(() => ready.map((r) => r.sessionId)).toEqual([first, second]);
  });

  it("cancels a run and marks the session cancelled", async () => {
    runStages = stages({
      scorer: { score: () => new Promise(() => {}) },
    });
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    const c = controller();
    const running = c.runSession(id);
    await expect.poll(() => c.status.run.stage).toBe("scoring");
    expect(c.cancel()).toBe(true);
    await running;
    expect(c.status.run.stage).toBe("cancelled");
    expect((await listSessions(root)).find((s) => s.id === id)?.processed?.status).toBe(
      "cancelled",
    );
    expect(ready).toEqual([]);
  });

  it("shows a Mode B run's count as it goes", async () => {
    const c = controller();
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 5,
      target: 100,
    });
    expect(c.status.collection.state).toBe("idle");

    await c.startCollection();
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 100 });
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 40,
      target: 100,
    });
    expect(c.status.collection).toMatchObject({ state: "collecting", count: 40, target: 100 });
  });

  it("shows each feed's count of a collection over X and Instagram", async () => {
    const c = controller();
    await c.startCollection();
    c.handleHostEvent({
      type: "collection-start-result",
      outcome: "started",
      target: 100,
      sources: ["x", "instagram"],
    });
    expect(c.status.collection.sources).toEqual([
      { source: "x", count: null },
      { source: "instagram", count: null },
    ]);
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 100,
      target: 100,
    });
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 12,
      target: 100,
      source: "instagram",
    });
    expect(c.status.collection).toMatchObject({
      state: "collecting",
      sources: [
        { source: "x", count: 100 },
        { source: "instagram", count: 12 },
      ],
    });
    expect(describeRun(c.status)).toBe(
      "Collecting in the browser… X 100 / 100 · Instagram 12 / 100",
    );
    expect(messages("en").collectingFeeds(100, ["x", "instagram"])).toMatch(
      /^The extension is collecting 100 posts from each of X and Instagram, one after the other\./,
    );
    expect(messages("tr").collectingFeeds(100, ["x", "instagram"])).toMatch(
      /^Eklenti X ve Instagram akışlarının her birinden sırayla 100 gönderi topluyor\./,
    );
    expect(describeRun({ ...c.status, lang: "tr" })).toBe(
      "Tarayıcıda toplanıyor… X 100 / 100 · Instagram 12 / 100",
    );
  });

  it("says nothing can be collected when every source is off, and the Mode A places", () => {
    const c = controller();
    c.handleHostEvent({ type: "collection-start-result", outcome: "no-sources", target: 100 });
    expect(c.status.collection.state).toBe("refused");
    expect(say("en", c.status.collection.message)).toBe(messages("en").noSources);
    c.handleHostEvent({
      type: "collection-start-result",
      outcome: "mode-b-off",
      target: 100,
      sources: ["x", "instagram"],
    });
    expect(say("en", c.status.collection.message)).toMatch(
      /Browse x\.com\/home and instagram\.com in your browser; once 100 posts are collected from each/,
    );
  });

  it("builds a run where X was not logged in but Instagram delivered, naming X's reason", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch({
      capturedAt: "2026-01-01T10:00:02.000Z",
      items: [instagramPost("ig1"), instagramPost("ig2")],
    });
    const sources: CollectSourceOutcome[] = [
      { source: "x", uniquePostCount: 0, reason: "not-logged-in", target: 100 },
      { source: "instagram", uniquePostCount: 2, reason: "stalled", target: 100 },
    ];
    const id = (await store.complete({
      mode: "B",
      reason: "not-logged-in",
      uniquePostCount: 0,
      responseCount: 0,
      target: 100,
      sources,
    })) as string;
    const judged: FeedItem[][] = [];
    const c = mixedController(judged);
    c.handleHostEvent({ ...completeEvent(id, "not-logged-in", 0), sources });
    await expect.poll(() => c.status.run.stage).toBe("ready");
    expect(judged.flat().map(platformOf)).toEqual(["instagram", "instagram"]);
    expect(say("en", c.status.collection.message)).toBe(
      "Target not reached — the timeline uses X: 0 of 100 posts (not logged in to X in this browser); " +
        "Instagram: 2 of 100 posts (no new posts for about 20 s of scrolling).",
    );
    const doc = JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
      missingSources: { label: string; reason: string }[];
    };
    expect(doc.missingSources).toEqual([
      { label: "x", reason: messages("en").sourceNotLoggedInX },
    ]);
    const html = await readFile(join(root, id, TIMELINE_FILE), "utf8");
    expect(html).toContain(`(${messages("en").sourceNotLoggedInX.replace(/\.$/, "")})`);
  });

  it("leaves out the stored items of a feed whose tick was turned off before completion", async () => {
    const seed = async (at: string, sources?: CollectSourceOutcome[]) => {
      const store = new PostSessionStore(root, () => at);
      await store.addBatch(batch(["1", "2"]));
      await store.addFeedBatch({
        capturedAt: "2026-01-01T10:00:02.000Z",
        items: [instagramPost("ig1")],
      });
      await store.addFeedBatch(feedBatch("news.example/world", [genericItem("g1")]));
      return (await store.complete({
        mode: "A",
        reason: "target-reached",
        uniquePostCount: 2,
        responseCount: 0,
        target: 2,
        ...(sources ? { sources } : {}),
      })) as string;
    };
    const judgedFor = async (id: string) => {
      const judged: FeedItem[][] = [];
      await mixedController(judged).runSession(id);
      return judged.flat().map((item) => `${platformOf(item)}:${item.id}`);
    };
    // Instagram turned off: X alone completed (no `sources`); its sites stay.
    const xOnly = await seed("2026-01-01T10:00:00.000Z");
    expect(await judgedFor(xOnly)).toEqual(["x:1", "x:2", "generic:g1"]);
    // X turned off: Instagram alone completed.
    const igOnly = await seed("2026-01-01T11:00:00.000Z", [
      { source: "instagram", uniquePostCount: 1, reason: "target-reached", target: 2 },
    ]);
    expect(await judgedFor(igOnly)).toEqual(["instagram:ig1", "generic:g1"]);
  });

  it("leaves Instagram's suggestions out on 'only accounts I follow', counted apart", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch({
      capturedAt: "2026-01-01T10:00:02.000Z",
      items: [instagramPost("ig1"), { ...instagramPost("ig2"), suggested: true }],
    });
    const id = (await store.complete({
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 0,
      responseCount: 0,
      target: 100,
      sources: [
        { source: "instagram", uniquePostCount: 1, reason: "target-reached", target: 100 },
      ],
    })) as string;
    runStages = stages({
      scorer: {
        score: async (items) =>
          items.map((item) => ({
            postId: feedItemKey(item),
            clickbaitScore: 0.1,
            readWorthinessScore: 0.6,
            checkWorthy: false,
            checkWorthyClaim: null,
          })),
      },
    });
    const run = async (instagramFollowedOnly: boolean) => {
      const c = controller(undefined, {
        loadSettings: async () => SettingsSchema.parse({ instagramFollowedOnly }),
        renderTimeline: (doc, lang) => renderTimeline(doc, { actions: true, lang }),
      });
      await c.runSession(id);
      expect(c.status.run.stage).toBe("ready");
      return {
        doc: JSON.parse(await readFile(join(root, id, TIMELINE_DOC_FILE), "utf8")) as {
          cards: { post: { id: string } }[];
          funnel: Record<string, number>;
        },
        html: await readFile(join(root, id, TIMELINE_FILE), "utf8"),
      };
    };
    const followedOnly = await run(true);
    expect(followedOnly.doc.cards.map((card) => card.post.id)).toEqual(["ig1"]);
    expect(followedOnly.doc.funnel).toMatchObject({ scanned: 2, notFollowed: 1, shown: 1 });
    expect(followedOnly.html).toContain("Instagram posts from accounts you do not follow");

    const all = await run(false);
    expect(all.doc.cards.map((card) => card.post.id).sort()).toEqual(["ig1", "ig2"]);
    expect(all.doc.funnel).not.toHaveProperty("notFollowed");
    expect(all.html).not.toContain("Instagram posts from accounts you do not follow");
  });

  it("waits for the user's go on a Mode A collection finished early, with each feed's count", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addBatch(batch(["1", "2", "3"]));
    await store.addFeedBatch({
      capturedAt: "2026-01-01T10:00:02.000Z",
      items: [instagramPost("ig1")],
    });
    const sources: CollectSourceOutcome[] = [
      { source: "x", uniquePostCount: 3, reason: "finished-early", target: 120 },
      { source: "instagram", uniquePostCount: 1, reason: "finished-early", target: 120 },
    ];
    const id = (await store.complete({
      mode: "A",
      reason: "finished-early",
      uniquePostCount: 3,
      responseCount: 0,
      target: 120,
      sources,
    })) as string;
    const c = controller();
    c.handleHostEvent({
      type: "collection-complete",
      sessionId: id,
      mode: "A",
      reason: "finished-early",
      uniquePostCount: 3,
      responseCount: 0,
      target: 120,
      sources,
    });
    await expect.poll(() => c.status.pending?.uniquePostCount).toBe(4);
    expect(c.status.pending?.sources).toEqual(sources);
    expect(asked).toEqual([{ sessionId: id, uniquePostCount: 4 }]);
    expect(messages("en").pendingFeeds("A", sources)).toBe(
      "Collected while you browsed: X: 3 of 120 posts (finished by you); " +
        "Instagram: 1 of 120 posts (finished by you). Build the timeline? (Uses your claude CLI.)",
    );
    expect(c.status.run.stage).toBe("idle");
    await c.buildPending();
    expect(c.status.run.stage).toBe("ready");
  });

  it("builds a Mode B collection that stopped short of the target, and says so", async () => {
    const id = await stoppedSession("stalled", 84);
    const c = controller();
    c.handleHostEvent(completeEvent(id, "stalled", 84));
    await expect.poll(() => c.status.run.stage).toBe("ready");
    expect(say("en", c.status.collection.message)).toBe(
      "Target not reached — the timeline uses 84 of 100 posts (no new posts for about 20 s of scrolling).",
    );
    expect(say("tr", c.status.collection.message)).toBe(
      "Hedefe ulaşılamadı — akış 84 / 100 gönderi ile oluşturuluyor (yaklaşık 20 sn kaydırmada yeni gönderi gelmedi).",
    );
    expect(ready.map((r) => r.sessionId)).toEqual([id]);
  });

  it("asks before building a Mode B collection that stopped for another reason", async () => {
    const id = await stoppedSession("not-logged-in", 3);
    const c = controller();
    c.handleHostEvent(completeEvent(id, "not-logged-in", 3));
    await expect
      .poll(() => c.status.pending)
      .toEqual({
        sessionId: id,
        uniquePostCount: 3,
        mode: "B",
        reason: "not-logged-in",
        target: 100,
      });
    expect(asked).toEqual([{ sessionId: id, uniquePostCount: 3 }]);
    expect(c.status.run.stage).toBe("idle");
    expect((await listSessions(root))[0]?.processed).toBeNull();
    await c.buildPending();
    expect(c.status.run.stage).toBe("ready");
  });

  it("keeps a run stopped by a settings change waiting, without a notification", async () => {
    const id = await stoppedSession("settings-changed", 3);
    const c = controller();
    c.handleHostEvent(completeEvent(id, "settings-changed", 3));
    await expect.poll(() => c.status.pending?.sessionId).toBe(id);
    expect(asked).toEqual([]);
    expect(c.status.run.stage).toBe("idle");
    await c.buildPending();
    expect(c.status.run.stage).toBe("ready");
  });

  it("never builds a collection the user cancelled", async () => {
    const id = await stoppedSession("cancelled", 3);
    const c = controller();
    c.handleHostEvent(completeEvent(id, "cancelled", 3));
    await expect
      .poll(async () => (await listSessions(root))[0]?.processed?.status)
      .toBe("cancelled");
    expect(c.status.pending).toBeNull();
    expect(say("en", c.status.collection.message)).toMatch(
      /stopped \(stopped by you\); no timeline/,
    );
    await c.processPending();
    expect(ready).toEqual([]);
  });

  it("gives up on an unanswered request and on a silent collection, and revives it", async () => {
    const c = controller(undefined, { collectionTimeoutsMs: { answerMs: 20, silenceMs: 40 } });
    await c.startCollection();
    await expect.poll(() => c.status.collection.state).toBe("refused");
    expect(say("en", c.status.collection.message)).toMatch(/did not answer/);

    await c.startCollection();
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 40,
      target: 120,
    });
    await expect.poll(() => c.status.collection.state).toBe("refused");
    expect(say("en", c.status.collection.message)).toMatch(
      /No word .* \(40 of 120 posts so far\)/,
    );

    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 60,
      target: 120,
    });
    expect(c.status.collection).toMatchObject({ state: "collecting", count: 60 });
  });

  it("cancels a running collection through the extension", async () => {
    const c = controller();
    await c.startCollection();
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    expect(c.cancel()).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "stop-collection" });
    expect(c.status.collection.state).toBe("cancelling");

    // Late progress does not bring "collecting" back.
    c.handleHostEvent({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 5,
      target: 120,
    });
    expect(c.status.collection.state).toBe("cancelling");

    const id = await stoppedSession("cancelled", 3);
    c.handleHostEvent(completeEvent(id, "cancelled", 3));
    await expect
      .poll(async () => (await listSessions(root))[0]?.processed?.status)
      .toBe("cancelled");
    expect(c.status.collection).toMatchObject({ state: "idle", count: null });
    expect(say("en", c.status.collection.message)).toMatch(/no timeline was built/);
    expect(c.status.run.stage).toBe("idle");
  });

  it("asks instead of building when a complete races a cancel", async () => {
    const c = controller();
    await c.startCollection();
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    expect(c.cancel()).toBe(true);
    expect(c.status.collection.state).toBe("cancelling");

    // The stop loses the race: the run reaches its target first.
    const id = await stoppedSession("target-reached", 3);
    c.handleHostEvent(completeEvent(id, "target-reached", 3));
    await expect.poll(() => c.status.pending?.sessionId).toBe(id);
    expect(c.status.run.stage).toBe("idle"); // no LLM run started
    expect(ready).toEqual([]);
    expect(asked).toEqual([{ sessionId: id, uniquePostCount: 3 }]);
    expect((await listSessions(root))[0]?.processed).toBeNull();
    expect(c.status.collection.state).toBe("idle");
  });

  it("ends cancelling at once on the extension's refusal", async () => {
    const c = controller();
    await c.startCollection();
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    expect(c.cancel()).toBe(true);

    // A late "started" belongs to a run that no longer exists: ignored.
    c.handleHostEvent({ type: "collection-start-result", outcome: "started", target: 120 });
    expect(c.status.collection.state).toBe("cancelling");

    c.handleHostEvent({ type: "collection-start-result", outcome: "mode-b-off", target: 120 });
    expect(c.status.collection).toMatchObject({ state: "refused" });
    expect(say("en", c.status.collection.message)).toMatch(/Browse x\.com\/home/);
  });

  it("counts a collection as cancelled when the extension does not confirm or is gone", async () => {
    const c = controller(undefined, { collectionTimeoutsMs: { answerMs: 20 } });
    await c.startCollection();
    c.cancel();
    expect(c.status.collection.state).toBe("cancelling");
    await expect.poll(() => c.status.collection.state).toBe("idle");
    expect(say("en", c.status.collection.message)).toMatch(/Collection cancelled/);

    await c.startCollection();
    hostOnline = false;
    expect(c.cancel()).toBe(true);
    expect(c.status.collection).toMatchObject({
      state: "idle",
      message: { key: "collectionCancelled" },
    });
    expect(c.cancel()).toBe(false); // nothing left to cancel
  });

  it("drops an old run's Try again once a new collection starts", async () => {
    runStages = stages({
      checkAvailable: async () => ({ ok: false, reason: "not-found", detail: "x" }),
    });
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    const c = controller();
    await c.runSession(id);
    expect(c.status.run.stage).toBe("error");
    await c.startCollection();
    expect(c.status.run).toMatchObject({ stage: "idle", error: null, sessionId: id });
  });

  /** A session with one batch and no complete.json (Mode B: session.json too). */
  async function openSession(at: string, ids: string[], mode: "A" | "B"): Promise<void> {
    const store = new PostSessionStore(root, () => at);
    if (mode === "B") await store.markMode("B");
    await store.addBatch(batch(ids));
  }

  it("counts Mode B sessions whose collection never completed, without touching them", async () => {
    await openSession("2026-01-01T09:00:00.000Z", ["1"], "B");
    await completeSession(root, "2026-01-01T10:00:00.000Z", ["2"], "A");
    const c = controller();
    await c.processPending();
    expect(c.status.unfinished).toEqual({ count: 1, newestAt: "2026-01-01T09:00:00.000Z" });
    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.batchCount)).toEqual([1, 1]);
    expect(sessions[0]?.processed).toBeNull();
  });

  it("leaves Mode A browsing and the newest session (maybe still collecting) uncounted", async () => {
    await openSession("2026-01-01T08:00:00.000Z", ["1"], "A");
    await openSession("2026-01-01T09:00:00.000Z", ["2"], "B");
    await openSession("2026-01-01T10:00:00.000Z", ["3"], "B");
    const c = controller();
    await c.processPending();
    expect(c.status.unfinished).toEqual({ count: 1, newestAt: "2026-01-01T09:00:00.000Z" });
  });

  it("counts the newest session once a later collection was asked for", async () => {
    await openSession("2026-01-01T09:00:00.000Z", ["1"], "B");
    await openSession("2026-01-01T10:00:00.000Z", ["2"], "B");
    const c = controller();
    await c.processPending();
    expect(c.status.unfinished.count).toBe(1);

    // "now" is 12:00: the new run has no folder yet; 10:00 is not it.
    await c.startCollection();
    await c.processPending();
    expect(c.status.unfinished).toEqual({ count: 2, newestAt: "2026-01-01T10:00:00.000Z" });

    // Its first batch lands: the run's own session is never counted.
    await openSession("2026-01-01T12:00:01.000Z", ["3"], "B");
    await c.processPending();
    expect(c.status.unfinished).toEqual({ count: 2, newestAt: "2026-01-01T10:00:00.000Z" });
  });

  it("never counts a session it cannot read as empty; the run reports it", async () => {
    const store = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await store.addFeedBatch(feedBatch("news.example/world", [genericItem("g1")]));
    const id = (await store.complete({
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 0,
      responseCount: 1,
    })) as string;
    await rm(join(root, id, "batches"), { recursive: true, force: true });
    const c = controller();
    c.handleHostEvent(completeEvent(id, "target-reached", 0));
    await expect.poll(() => c.status.run.error?.kind).toBe("session-unreadable");
    expect(c.status.collection.message).not.toEqual(note("endedEmpty", "target-reached"));
    expect((await listSessions(root)).find((s) => s.id === id)?.processed?.status).not.toBe(
      "cancelled",
    );
  });

  it("reports an unreadable session instead of crashing", async () => {
    const c = controller();
    await c.runSession("2026-01-01T10-00-00-000Z-dead");
    expect(c.status.run.error?.kind).toBe("session-unreadable");
  });
});
