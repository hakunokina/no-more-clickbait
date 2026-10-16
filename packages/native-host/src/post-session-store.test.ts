import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedBatch, GenericItem, Post, PostBatch } from "@nmc/core";
import {
  listSessions,
  loadSession,
  markSessionProcessed,
  PostSessionStore,
  pruneSessions,
  sessionsRoot,
} from "./post-session-store.js";

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

function batch(capturedAt: string, ids: string[]): PostBatch {
  return { source: "x-home-timeline", capturedAt, posts: ids.map(post) };
}

function genericItem(id: string): GenericItem {
  return {
    platform: "generic",
    id,
    sourceLabel: "custom:news.example/world",
    title: `synthetic title ${id}`,
    url: `https://news.example/world/${id}`,
    domain: "news.example",
    promoted: false,
  };
}

function feedBatch(capturedAt: string, ids: string[]): FeedBatch {
  return { siteId: "news.example/world", capturedAt, items: ids.map(genericItem) };
}

describe("PostSessionStore", () => {
  let root: string;
  let clock: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-sessions-test-"));
    clock = "2026-01-01T10:00:00.000Z";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lives under %LOCALAPPDATA%\\NoMoreClickbait\\sessions", () => {
    expect(sessionsRoot({ LOCALAPPDATA: "C:\\L" })).toBe(
      join("C:\\L", "NoMoreClickbait", "sessions"),
    );
  });

  it("stores batches, completes and reads the session back", async () => {
    const store = new PostSessionStore(root, () => clock);
    expect(store.sessionId).toBeNull();
    await store.addBatch(batch("2026-01-01T10:00:01.000Z", ["1", "2"]));
    await store.addBatch(batch("2026-01-01T10:00:05.000Z", ["2", "3"]));
    const id = await store.complete({
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 3,
      responseCount: 2,
    });
    expect(id).toBe(store.sessionId);
    expect(id).toMatch(/^2026-01-01T10-00-00-000Z-[0-9a-f]{4}$/);

    const loaded = await loadSession(root, id as string);
    expect(loaded.posts.map((p) => p.id)).toEqual(["1", "2", "2", "3"]);
    expect(loaded.batchCount).toBe(2);
    expect(loaded.completion).toMatchObject({ mode: "B", uniquePostCount: 3 });
    expect(loaded.collection).toEqual({
      firstCapturedAt: "2026-01-01T10:00:01.000Z",
      lastCapturedAt: "2026-01-01T10:00:05.000Z",
      postCount: 4,
      uniquePostCount: 3,
      responseCount: 2,
    });
  });

  it("refuses batches after completion and has no session without batches", async () => {
    const empty = new PostSessionStore(root, () => clock);
    await expect(
      empty.complete({ mode: "A", reason: "x", uniquePostCount: 0, responseCount: 0 }),
    ).resolves.toBeNull();
    await expect(empty.addBatch(batch(clock, ["1"]))).resolves.toBe(false);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("skips tampered batches and rejects unsafe session ids", async () => {
    const store = new PostSessionStore(root, () => clock);
    await store.addBatch(batch(clock, ["1"]));
    const id = store.sessionId as string;
    await writeFile(join(root, id, "batches", "0002.json"), '{"posts": "nope"}', "utf8");
    const loaded = await loadSession(root, id);
    expect(loaded.posts).toHaveLength(1);
    expect(loaded.invalidBatchCount).toBe(1);
    await expect(loadSession(root, "..\\..\\Windows")).rejects.toThrow();
  });

  it("stores feed batches beside X batches, outside the X counts", async () => {
    const store = new PostSessionStore(root, () => clock);
    await store.addBatch(batch("2026-01-01T10:00:01.000Z", ["1"]));
    await expect(
      store.addFeedBatch(feedBatch("2026-01-01T10:00:02.000Z", ["a", "b"])),
    ).resolves.toBe(2);
    const id = store.sessionId as string;
    const files = (await readdir(join(root, id, "batches"))).sort();
    expect(files).toEqual(["0001.json", "f0002.json"]);

    const loaded = await loadSession(root, id);
    expect(loaded.posts.map((p) => p.id)).toEqual(["1"]);
    expect(loaded.batchCount).toBe(1);
    expect(loaded.feedBatchCount).toBe(1);
    expect(loaded.feedItems.map((item) => item.id)).toEqual(["a", "b"]);
    expect(loaded.feedSiteIds).toEqual(["news.example/world"]);
    expect(loaded.invalidBatchCount).toBe(0);
  });

  it("keeps each custom site's outcome with the completion", async () => {
    const store = new PostSessionStore(root, () => clock);
    await store.addBatch(batch(clock, ["1"]));
    await store.addFeedBatch({ siteId: "quiet.example", capturedAt: clock, items: [] });
    const sites = [
      { siteId: "news.example/world", status: "ok" as const, method: "rss", itemCount: 2 },
      { siteId: "broken.example", status: "error" as const, itemCount: 0, message: "HTTP 503" },
    ];
    const id = (await store.complete({
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 1,
      responseCount: 1,
      sites,
    })) as string;
    const loaded = await loadSession(root, id);
    expect(loaded.completion?.sites).toEqual(sites);
    // A batch without items does not count as the site delivering.
    expect(loaded.feedSiteIds).toEqual([]);
    expect((await listSessions(root))[0]?.completion?.sites).toEqual(sites);
  });

  it("refuses feed batches after completion and skips tampered ones", async () => {
    const store = new PostSessionStore(root, () => clock);
    await store.addFeedBatch(feedBatch(clock, ["a"]));
    const id = store.sessionId as string;
    await writeFile(join(root, id, "batches", "f0002.json"), '{"items": "nope"}', "utf8");
    await store.complete({ mode: "A", reason: "x", uniquePostCount: 0, responseCount: 0 });
    await expect(store.addFeedBatch(feedBatch(clock, ["b"]))).resolves.toBe(0);
    const loaded = await loadSession(root, id);
    expect(loaded.feedItems.map((item) => item.id)).toEqual(["a"]);
    expect(loaded.invalidBatchCount).toBe(1);
  });

  it("lists sessions with their complete/processed state", async () => {
    const a = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await a.addBatch(batch(clock, ["1"]));
    await a.complete({
      mode: "A",
      reason: "target-reached",
      uniquePostCount: 1,
      responseCount: 1,
    });
    const b = new PostSessionStore(root, () => "2026-01-01T11:00:00.000Z");
    await b.addBatch(batch(clock, ["2"]));
    await markSessionProcessed(join(root, a.sessionId as string), "done", () => clock);

    const sessions = await listSessions(root);
    expect(sessions.map((s) => [s.id, s.complete, s.processed?.status ?? null])).toEqual([
      [a.sessionId, true, "done"],
      [b.sessionId, false, null],
    ]);
  });

  it("records a Mode B run in session.json, also when it reports before the first batch", async () => {
    const early = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await early.markMode("B");
    await early.addBatch(batch(clock, ["1"]));
    await early.markMode("A"); // the first mode stays
    const plain = new PostSessionStore(root, () => "2026-01-01T11:00:00.000Z");
    await plain.addBatch(batch(clock, ["2"]));

    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.info)).toEqual([
      { mode: "B", startedAt: "2026-01-01T10:00:00.000Z" },
      null,
    ]);
  });

  it("records the collecting browser with the mode, waiting for a slow identity before completing", async () => {
    let resolveBrowser: (family: "brave") => void = () => undefined;
    const browser = new Promise<"brave">((resolve) => {
      resolveBrowser = resolve;
    });
    const store = new PostSessionStore(root, () => clock);
    const marked = store.markMode("B", browser);
    const added = store.addBatch(batch(clock, ["1"]));
    const completed = store.complete({
      mode: "B",
      reason: "target",
      uniquePostCount: 1,
      responseCount: 1,
    });
    resolveBrowser("brave");
    await Promise.all([marked, added, completed]);
    const unknown = new PostSessionStore(root, () => "2026-01-01T11:00:00.000Z");
    await unknown.markMode("B", Promise.resolve("other"));
    await unknown.addBatch(batch(clock, ["2"]));

    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.info)).toEqual([
      { mode: "B", startedAt: clock, browser: "brave" },
      { mode: "B", startedAt: "2026-01-01T11:00:00.000Z" },
    ]);
  });

  /** A session folder holding one batch file, optionally complete/processed. */
  async function session(
    hour: number,
    state: {
      complete?: boolean;
      processed?: "done" | "cancelled" | "superseded" | "error";
    } = {},
    batches = 1,
  ): Promise<string> {
    const id = `2026-01-01T${hour}-00-00-000Z-abcd`;
    const dir = join(root, id);
    await mkdir(join(dir, "batches"), { recursive: true });
    for (let n = 1; n <= batches; n += 1) {
      await writeFile(join(dir, "batches", `000${n}.json`), "{}");
    }
    if (state.complete) {
      await writeFile(
        join(dir, "complete.json"),
        JSON.stringify({
          mode: "A",
          reason: "target-reached",
          uniquePostCount: 1,
          responseCount: 0,
          completedAt: clock,
        }),
      );
    }
    if (state.processed) await markSessionProcessed(dir, state.processed, () => clock);
    return id;
  }

  it("keeps only the newest sessions, never the one being written", async () => {
    for (let hour = 10; hour < 14; hour += 1) await session(hour);
    await mkdir(join(root, "not-a-session"));
    await pruneSessions(root, 2, "2026-01-01T10-00-00-000Z-abcd");
    expect((await readdir(root)).sort()).toEqual([
      "2026-01-01T10-00-00-000Z-abcd",
      "2026-01-01T13-00-00-000Z-abcd",
      "not-a-session",
    ]);

    const store = new PostSessionStore(root, () => "2026-01-01T15:00:00.000Z", 2);
    await store.addBatch(batch(clock, ["1"]));
    const ids = (await listSessions(root)).map((s) => s.id);
    expect(ids).toEqual(["2026-01-01T13-00-00-000Z-abcd", store.sessionId]);
  });

  it("keeps the timeline being read, the run in flight and the failed run; drops leftovers first", async () => {
    const done = await session(10, { complete: true, processed: "done" });
    const failed = await session(11, { complete: true, processed: "error" });
    const running = await session(12, { complete: true });
    const plain = await session(13, { complete: true, processed: "done" }, 1);
    // Heavy Mode A browsing: superseded, cancelled and empty sessions pile up.
    const superseded = await session(14, { complete: true, processed: "superseded" });
    const cancelled = await session(15, { complete: true, processed: "cancelled" });
    const empty = await session(16, {}, 0);
    const current = await session(17);

    await pruneSessions(root, 5, current);
    let ids = (await listSessions(root)).map((s) => s.id);
    expect(ids).toEqual([done, failed, running, plain, current]);
    expect(ids).not.toContain(superseded);
    expect(ids).not.toContain(cancelled);
    expect(ids).not.toContain(empty);

    // Squeezed further: the oldest done goes, the newest done stays.
    await pruneSessions(root, 4, current);
    ids = (await listSessions(root)).map((s) => s.id);
    expect(ids).toEqual([failed, running, plain, current]);

    // Never below the protected ones, even with a tiny limit.
    await pruneSessions(root, 1, current);
    ids = (await listSessions(root)).map((s) => s.id);
    expect(ids).toEqual([failed, running, plain, current]);
  });

  it("never takes a session of only custom-site items for an empty one", async () => {
    const older = await session(10, { complete: true });
    const sitesOnly = await session(11, { complete: true }, 0);
    await writeFile(join(root, sitesOnly, "batches", "f0001.json"), "{}");
    const empty = await session(12, {}, 0);
    const current = await session(13);
    expect((await listSessions(root)).find((s) => s.id === sitesOnly)).toMatchObject({
      batchCount: 0,
      feedBatchCount: 1,
    });
    await pruneSessions(root, 2, current);
    const ids = (await listSessions(root)).map((s) => s.id);
    // The empty one goes first, then the oldest; the newer sites-only session stays.
    expect(ids).toEqual([sitesOnly, current]);
    expect(ids).not.toContain(older);
    expect(ids).not.toContain(empty);
  });

  it("records a failed run with its reason", async () => {
    const id = await session(10, { complete: true });
    await markSessionProcessed(join(root, id), "error", () => clock, {
      kind: "cli-error",
      message: "The claude CLI failed.",
    });
    const [listed] = await listSessions(root);
    expect(listed?.processed).toEqual({
      status: "error",
      processedAt: clock,
      error: { kind: "cli-error", message: "The claude CLI failed." },
    });
  });
});
