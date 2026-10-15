import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Post, PostBatch } from "@nmc/core";
import { createCollectionRelay } from "./collection-relay.js";
import { listSessions, PostSessionStore } from "./post-session-store.js";

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

describe("createCollectionRelay", () => {
  const dirs: string[] = [];
  const clock = "2026-01-01T10:00:00.000Z";

  async function freshRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nmc-relay-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("tags Mode B only on progress, never on start-result", async () => {
    // The start-result can arrive over the previous port, whose session is
    // the user's own browsing (Mode A): it must stay untagged even when a
    // batch lands in it afterwards. Both answers are still relayed.
    const oldStore = new PostSessionStore(await freshRoot(), () => clock);
    const oldSent: unknown[] = [];
    const oldRelay = createCollectionRelay(oldStore, (message) => {
      oldSent.push(message);
    });
    await oldRelay.onCollectionStartResult({
      type: "collection-start-result",
      outcome: "started",
      target: 100,
    });
    expect(oldStore.sessionId).toBeNull();

    // The run's own host session: its first progress tags it Mode B.
    const runRoot = await freshRoot();
    const runStore = new PostSessionStore(runRoot, () => clock);
    const runSent: unknown[] = [];
    const runRelay = createCollectionRelay(runStore, (message) => {
      runSent.push(message);
    });
    await runRelay.onCollectionProgress({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 1,
      target: 100,
    });
    await runStore.addBatch(batch(clock, ["2"]));
    const [runSession] = await listSessions(runRoot);
    expect(runSession?.info).toMatchObject({ mode: "B" });
    expect(runSent).toHaveLength(1);

    // …while the previous session keeps collecting untagged.
    await oldStore.addBatch(batch(clock, ["1"]));
    const oldRoot = dirs[0] as string;
    const [oldSession] = await listSessions(oldRoot);
    expect(oldSession?.info).toBeNull();
    expect(oldSent).toHaveLength(1);
  });

  it("puts the host's browser into the Mode B tag", async () => {
    const root = await freshRoot();
    const store = new PostSessionStore(root, () => clock);
    const relay = createCollectionRelay(
      store,
      () => undefined,
      () => Promise.resolve("edge"),
    );
    await relay.onCollectionProgress({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 1,
      target: 100,
    });
    await store.addBatch(batch(clock, ["1"]));
    const [session] = await listSessions(root);
    expect(session?.info).toEqual({ mode: "B", startedAt: clock, browser: "edge" });
  });
});
