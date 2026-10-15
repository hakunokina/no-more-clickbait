import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Post, PostBatch } from "@nmc/core";
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

  it("lists sessions with their complete/processed state", async () => {
    const a = new PostSessionStore(root, () => "2026-01-01T10:00:00.000Z");
    await a.addBatch(batch(clock, ["1"]));
    await a.complete({ mode: "A", reason: "target-reached", uniquePostCount: 1, responseCount: 1 });
    const b = new PostSessionStore(root, () => "2026-01-01T11:00:00.000Z");
    await b.addBatch(batch(clock, ["2"]));
    await markSessionProcessed(join(root, a.sessionId as string), "done", () => clock);

    const sessions = await listSessions(root);
    expect(sessions.map((s) => [s.id, s.complete, s.processed?.status ?? null])).toEqual([
      [a.sessionId, true, "done"],
      [b.sessionId, false, null],
    ]);
  });

  it("keeps only the newest sessions, never the one being written", async () => {
    for (let hour = 10; hour < 14; hour += 1) {
      await mkdir(join(root, `2026-01-01T${hour}-00-00-000Z-abcd`), { recursive: true });
    }
    await mkdir(join(root, "not-a-session"));
    await pruneSessions(root, 2, "2026-01-01T10-00-00-000Z-abcd");
    expect((await readdir(root)).sort()).toEqual([
      "2026-01-01T10-00-00-000Z-abcd",
      "2026-01-01T12-00-00-000Z-abcd",
      "2026-01-01T13-00-00-000Z-abcd",
      "not-a-session",
    ]);

    const store = new PostSessionStore(root, () => "2026-01-01T15:00:00.000Z", 2);
    await store.addBatch(batch(clock, ["1"]));
    const ids = (await listSessions(root)).map((s) => s.id);
    expect(ids).toEqual(["2026-01-01T13-00-00-000Z-abcd", store.sessionId]);
  });
});
