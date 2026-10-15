import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Post, PostBatch } from "@nmc/core";
import { listSessions, PostSessionStore, type DesktopCommand } from "@nmc/native-host";
import type { DesktopStatus } from "../shared/status.js";
import { PipelineRunner, type RunStages } from "./pipeline-runner.js";
import { SessionController, TIMELINE_FILE } from "./session-controller.js";
import { PIPELINE_DEFAULTS } from "./settings-file.js";

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
  return { source: "x-home-timeline", capturedAt: "2026-01-01T10:00:01.000Z", posts: ids.map(post) };
}

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

async function completeSession(root: string, at: string, ids: string[]): Promise<string> {
  const store = new PostSessionStore(root, () => at);
  await store.addBatch(batch(ids));
  return (await store.complete({
    mode: "B",
    reason: "target-reached",
    uniquePostCount: ids.length,
    responseCount: 1,
  })) as string;
}

describe("SessionController", () => {
  let root: string;
  let statuses: DesktopStatus[];
  let ready: { sessionId: string; timelinePath: string; selected: number }[];
  let sent: DesktopCommand[];
  let hostOnline: boolean;
  let runStages: RunStages;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-controller-test-"));
    statuses = [];
    ready = [];
    sent = [];
    hostOnline = true;
    runStages = stages();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(): SessionController {
    return new SessionController({
      sessionsRoot: root,
      runner: new PipelineRunner(() => runStages),
      loadSettings: async () => ({ ...PIPELINE_DEFAULTS, collectTarget: 120 }),
      renderTimeline: ({ result }) => `<p>${result.posts.length} posts</p>`,
      sendToHost: (command) => {
        if (!hostOnline) return false;
        sent.push(command);
        return true;
      },
      onStatus: (status) => statuses.push(status),
      onReady: (info) => ready.push(info),
      now: () => "2026-01-01T12:00:00.000Z",
    });
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
    expect(c.status.collection.message).toMatch(/browser or the extension is not running/);
  });

  it("relays the Mode B off instruction", () => {
    const c = controller();
    c.handleHostEvent({ type: "collection-start-result", outcome: "mode-b-off", target: 250 });
    expect(c.status.collection.state).toBe("refused");
    expect(c.status.collection.message).toMatch(/Browse x\.com\/home/);
  });

  it("runs a completed collection and writes the timeline", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1", "2", "2"]);
    const c = controller();
    await c.runSession(id);

    expect(c.status.run).toMatchObject({ stage: "ready", sessionId: id, hasTimeline: true });
    expect(c.status.run.counts).toMatchObject({ postsIn: 3, afterHardFilter: 2, selected: 2 });
    expect(ready).toEqual([{ sessionId: id, timelinePath: join(root, id, TIMELINE_FILE), selected: 2 }]);
    await expect(readFile(join(root, id, TIMELINE_FILE), "utf8")).resolves.toBe("<p>2 posts</p>");
    const [session] = await listSessions(root);
    expect(session?.processed?.status).toBe("done");
    const stages = statuses.map((s) => s.run.stage);
    expect(stages).toContain("scoring");
    expect(stages.at(-1)).toBe("ready");
  });

  it("starts the run from a host's collection-complete event", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    const c = controller();
    c.handleHostEvent({
      type: "collection-complete",
      sessionId: id,
      mode: "A",
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
    const byId = Object.fromEntries((await listSessions(root)).map((s) => [s.id, s.processed?.status]));
    expect(byId).toEqual({ [older]: "superseded", [newer]: "done" });
    await c.processPending();
    expect(ready).toHaveLength(1);
  });

  it("shows a CLI error, keeps the session pending and retries on request", async () => {
    const id = await completeSession(root, "2026-01-01T10:00:00.000Z", ["1"]);
    runStages = stages({
      checkAvailable: async () => ({ ok: false, reason: "not-found", detail: "ENOENT" }),
    });
    const c = controller();
    await c.processPending();
    expect(c.status.run.stage).toBe("error");
    expect(c.status.run.error?.kind).toBe("cli-not-found");
    expect((await listSessions(root))[0]?.processed).toBeNull();

    // Not retried automatically (no error loop on every host reconnect)...
    const before = statuses.length;
    await c.processPending();
    expect(statuses).toHaveLength(before);

    // ...but "Try again" does it, without collecting again.
    runStages = stages();
    await c.retry();
    expect(c.status.run.stage).toBe("ready");
    expect(ready.map((r) => r.sessionId)).toEqual([id]);
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
    expect(c.status.collection.message).toMatch(/being prepared/);
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
    expect((await listSessions(root))[0]?.processed?.status).toBe("cancelled");
    expect(ready).toEqual([]);
  });

  it("reports an unreadable session instead of crashing", async () => {
    const c = controller();
    await c.runSession("2026-01-01T10-00-00-000Z-dead");
    expect(c.status.run.error?.kind).toBe("session-unreadable");
  });
});
