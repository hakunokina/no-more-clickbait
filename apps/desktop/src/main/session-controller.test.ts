import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Post, type PostBatch } from "@nmc/core";
import { listSessions, PostSessionStore, type DesktopCommand } from "@nmc/native-host";
import { renderTimeline, TIMELINE_CSPS } from "@nmc/timeline-renderer";
import { say } from "../shared/i18n.js";
import type { DesktopStatus } from "../shared/status.js";
import { PipelineRunner, type RunStages } from "./pipeline-runner.js";
import {
  missingSourcesOf,
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
  it("lists enabled sources that delivered nothing while others did", () => {
    const delivered = [{ label: "x", in: 4, shown: 2 }];
    expect(missingSourcesOf(["x", "custom:Site"], delivered)).toEqual([
      { label: "custom:Site", reason: expect.any(String) as string },
    ]);
    expect(missingSourcesOf(["x"], delivered)).toEqual([]);
  });

  it("lists nothing when no source delivered (not a partial timeline)", () => {
    expect(missingSourcesOf(["x", "custom:Site"], undefined)).toEqual([]);
    expect(missingSourcesOf(["x"], [])).toEqual([]);
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
    expect((await listSessions(root))[0]?.processed?.status).toBe("cancelled");
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
    expect((await listSessions(root))[0]?.processed?.status).toBe("cancelled");
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

  it("reports an unreadable session instead of crashing", async () => {
    const c = controller();
    await c.runSession("2026-01-01T10-00-00-000Z-dead");
    expect(c.status.run.error?.kind).toBe("session-unreadable");
  });
});
