import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SettingsSchema,
  SyncedSettingsSchema,
  type BridgeMessage,
  type ModeBRunSummary,
  type Post,
  type PostBatch,
} from "@nmc/core";
import {
  encodeMessage,
  LinkServer,
  linkTokenPath,
  listSessions,
  MessageDecoder,
  sessionsRoot,
  writeLinkToken,
} from "@nmc/native-host";
import { NativeChannel } from "../../../extension/src/native-channel.js";
import type { DesktopStatus } from "../shared/status.js";
import { PipelineRunner, type RunStages } from "./pipeline-runner.js";
import { SessionController } from "./session-controller.js";

/*
 * End to end over the real pieces: the built native host runs as its own
 * process with framed stdio (as the browser launches it), links to a real
 * LinkServer over a real pipe, writes real session folders, and the
 * desktop's SessionController runs a fake pipeline over them. The test
 * plays the browser: a port's disconnect closes both stdio pipes at once,
 * like Chromium does, so the host's later writes fail (EPIPE). The
 * worker's port handling is the extension's own NativeChannel.
 */

const HOST_MAIN = fileURLToPath(
  new URL("../../../../packages/native-host/dist/main.js", import.meta.url),
);

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

function batchMessage(first: number, count: number): BridgeMessage {
  const batch: PostBatch = {
    source: "x-home-timeline",
    capturedAt: new Date().toISOString(),
    posts: Array.from({ length: count }, (_, i) => post(String(first + i))),
  };
  return { type: "post-batch", batch };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** chrome.runtime.connectNative stand-in over the real host process. */
class HostPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly received: { type: string }[] = [];
  readonly exited: Promise<number | null>;
  #stderr = "";
  #listeners: ((message: unknown) => void)[] = [];

  constructor(env: NodeJS.ProcessEnv) {
    this.#child = spawn(process.execPath, [HOST_MAIN], { env, windowsHide: true });
    const decoder = new MessageDecoder();
    this.#child.stdout.on("data", (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const message = JSON.parse(raw) as { type: string };
        this.received.push(message);
        for (const listener of this.#listeners) listener(message);
      }
    });
    this.#child.stdout.on("error", () => undefined);
    this.#child.stdin.on("error", () => undefined);
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.exited = new Promise((resolve) => this.#child.on("exit", resolve));
  }

  get stderr(): string {
    return this.#stderr;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#listeners.push(listener);
  }

  postMessage(message: unknown): void {
    this.#child.stdin.write(encodeMessage(message));
  }

  /** Like Chromium: both pipes close at once. */
  disconnect(): void {
    this.#child.stdin.end();
    this.#child.stdout.destroy();
  }

  count(type: string): number {
    return this.received.filter((message) => message.type === type).length;
  }
}

describe("collection over the real host, pipe and controller", () => {
  let local: string;
  let env: NodeJS.ProcessEnv;
  let server: LinkServer;
  let controller: SessionController;
  let statuses: DesktopStatus[];
  const ports: HostPort[] = [];

  function open(): HostPort {
    const port = new HostPort(env);
    ports.push(port);
    return port;
  }

  beforeEach(async () => {
    if (!existsSync(HOST_MAIN)) {
      throw new Error(`build the native host first (pnpm build): ${HOST_MAIN} is missing`);
    }
    local = await mkdtemp(join(tmpdir(), "nmc-link-e2e-"));
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\nmc-test-${randomBytes(6).toString("hex")}`
        : join(local, "link.sock");
    env = {
      ...process.env,
      LOCALAPPDATA: local,
      NMC_LINK_PIPE: pipe,
      NMC_INBOX_DIR: join(local, "captures"),
    };
    statuses = [];
    const stages: RunStages = {
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
    };
    controller = new SessionController({
      sessionsRoot: sessionsRoot(env),
      runner: new PipelineRunner(() => stages),
      loadSettings: async () => SettingsSchema.parse({ collectTarget: 100 }),
      renderTimeline: (doc) => `<p>${doc.cards.length} posts</p>`,
      sendToHost: (command) => server.send(command),
      onStatus: (status) => statuses.push(status),
      onReady: () => undefined,
    });
    const token = await writeLinkToken(linkTokenPath(env));
    server = new LinkServer({
      path: pipe,
      token,
      onEvent: (event) => controller.handleHostEvent(event),
      onHostsChanged: (hosts) => controller.setLink({ hosts }),
    });
    await server.listen();
    controller.setLink({ listening: true });
  });

  afterEach(async () => {
    for (const port of ports.splice(0)) {
      port.disconnect();
      await port.exited;
    }
    await server.close();
    await rm(local, { recursive: true, force: true });
  });

  it("keeps a collection the browser closes right after completing it", async () => {
    const port = open();
    port.postMessage({ type: "ping" });
    await until(() => server.hostCount === 1, "the host to link up");
    for (let i = 0; i < 3; i++) port.postMessage(batchMessage(i * 30, 30));
    await until(() => port.count("batch-accepted") === 3, "three batches stored");

    // The worker's last batch, the completion, and the port closing at once.
    port.postMessage(batchMessage(90, 30));
    port.postMessage({
      type: "collection-complete",
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 120,
      responseCount: 4,
    } satisfies BridgeMessage);
    port.disconnect();

    expect(await port.exited, port.stderr).toBe(0);
    const sessions = await listSessions(sessionsRoot(env));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.completion).toMatchObject({ mode: "B", uniquePostCount: 120 });
    expect(await readdir(join(sessions[0]?.dir ?? "", "batches"))).toHaveLength(4);
    // The desktop heard about it and built the timeline.
    await until(() => controller.status.run.stage === "ready", "the run to finish");
    const processed = JSON.parse(
      await readFile(join(sessions[0]?.dir ?? "", "processed.json"), "utf8"),
    ) as { status: string };
    expect(processed.status).toBe("done");
  }, 20_000);

  it("runs a desktop-started Mode B collection end to end, through a settings sync", async () => {
    const startRequests: unknown[] = [];
    const channel: NativeChannel<HostPort> = new NativeChannel(() => {
      const port = open();
      port.onMessage((message) => {
        channel.received(port, message);
        if ((message as { type: string }).type === "start-collection")
          startRequests.push(message);
      });
      return port;
    });
    const linkPort = channel.port();
    await until(() => server.hostCount === 1, "the worker's host to link up");

    await controller.startCollection();
    await until(() => startRequests.length === 1, "start-collection to reach the worker");
    // The worker answers on this port, then gives the run its own host session.
    channel.send({ type: "collection-start-result", outcome: "started", target: 100 });
    channel.retire();
    const runPort = channel.port();
    await until(
      () => controller.status.collection.state === "collecting",
      "the answer to reach the desktop",
    );
    expect(await linkPort.exited, linkPort.stderr).toBe(0);
    await until(() => server.hostCount === 1, "the run's host to link up");

    channel.send(batchMessage(0, 30));
    // Options "Save" mid-run: a one-shot host process (sendNativeMessage).
    const once = open();
    once.postMessage({
      type: "settings-sync",
      settings: SyncedSettingsSchema.parse(SettingsSchema.parse({ collectTarget: 100 })),
    } satisfies BridgeMessage);
    await until(() => once.count("settings-synced") === 1, "the settings sync");
    once.disconnect();
    expect(await once.exited, once.stderr).toBe(0);
    expect(server.hostCount).toBe(1); // a one-shot host never links

    channel.send(batchMessage(30, 30));
    channel.send({ type: "collection-progress", mode: "B", uniquePostCount: 55, target: 100 });
    channel.send(batchMessage(60, 30));
    channel.send({ type: "collection-progress", mode: "B", uniquePostCount: 84, target: 100 });
    await until(() => controller.status.collection.count === 84, "the count on the monitor");

    // X stopped giving posts: the run ends "stalled" at 84/100. Developer
    // capture on (host counter), so the run summary goes first.
    const summary: ModeBRunSummary = {
      strategy: "minimized-window",
      counter: "host",
      target: 100,
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:00:38.000Z",
      durationMs: 38_000,
      scrollCount: 60,
      scrollMovedCount: 26,
      hiddenStepCount: 37,
      responseCount: 3,
      uniquePostCount: 84,
      stopReason: "stalled",
    };
    channel.send({ type: "mode-b-run", run: summary });
    channel.send({
      type: "collection-complete",
      mode: "B",
      reason: "stalled",
      uniquePostCount: 84,
      responseCount: 3,
      target: 100,
    });
    channel.retire();
    channel.port(); // the next counting session

    expect(await runPort.exited, runPort.stderr).toBe(0);
    const sessions = await listSessions(sessionsRoot(env));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      batchCount: 3,
      completion: { mode: "B", reason: "stalled", uniquePostCount: 84, target: 100 },
    });
    await until(() => controller.status.run.stage === "ready", "the run to finish");
    expect(controller.status.collection.message).toMatch(
      /^Target not reached — the timeline uses 84 of 100 posts/,
    );
    const processed = JSON.parse(
      await readFile(join(sessions[0]?.dir ?? "", "processed.json"), "utf8"),
    ) as { status: string };
    expect(processed.status).toBe("done");
    expect(statuses.some((status) => status.collection.count === 55)).toBe(true);
    expect(existsSync(join(local, "NoMoreClickbait", "settings.json"))).toBe(true);
  }, 30_000);
});
