import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopDataDir,
  desktopPipePath,
  linkProof,
  LinkClient,
  LinkServer,
  newNonce,
  readLinkToken,
  writeLinkToken,
  type DesktopCommand,
  type HostEvent,
} from "./desktop-link.js";
import { encodeMessage, MessageDecoder } from "./framing.js";

/** A private, throwaway pipe/socket per test — never the real app's. */
function testPipePath(dir: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nmc-test-${randomBytes(6).toString("hex")}`
    : join(dir, "link.sock");
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (condition()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("timed out"));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

describe("link paths", () => {
  it("keeps everything under %LOCALAPPDATA%\\NoMoreClickbait", () => {
    expect(desktopDataDir({ LOCALAPPDATA: "C:\\L" })).toBe(join("C:\\L", "NoMoreClickbait"));
  });

  it("names the Windows pipe per user and sanitises the name", () => {
    expect(desktopPipePath({}, "win32", "Arda")).toBe("\\\\.\\pipe\\no-more-clickbait-Arda");
    expect(desktopPipePath({}, "win32", "a b\\c")).toBe("\\\\.\\pipe\\no-more-clickbait-a_b_c");
  });

  it("uses a socket in the data dir elsewhere", () => {
    expect(desktopPipePath({ LOCALAPPDATA: "/l" }, "linux", "x")).toBe(
      join("/l", "NoMoreClickbait", "link.sock"),
    );
  });
});

describe("desktop link", () => {
  let dir: string;
  let path: string;
  let tokenPath: string;
  let token: string;
  let server: LinkServer;
  let client: LinkClient | null;
  const events: HostEvent[] = [];
  const commands: DesktopCommand[] = [];
  let hostCount = 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-link-test-"));
    path = testPipePath(dir);
    tokenPath = join(dir, "link-token");
    token = await writeLinkToken(tokenPath);
    events.length = 0;
    commands.length = 0;
    hostCount = 0;
    client = null;
    server = new LinkServer({
      path,
      token,
      onEvent: (event) => events.push(event),
      onHostsChanged: (count) => (hostCount = count),
      handshakeTimeoutMs: 500,
    });
    await server.listen();
  });

  afterEach(async () => {
    client?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function startClient(retryMs = 50): LinkClient {
    client = new LinkClient({
      path,
      tokenPath,
      retryMs,
      onCommand: (command) => commands.push(command),
    });
    client.start();
    return client;
  }

  it("persists and re-reads the token", async () => {
    await expect(readLinkToken(tokenPath)).resolves.toBe(token);
    await writeFile(tokenPath, "not-a-token", "utf8");
    await expect(readLinkToken(tokenPath)).resolves.toBeNull();
  });

  it("rewrites the token while a host briefly holds it open", async () => {
    // Windows: replacing an open file fails with EPERM until it is closed.
    const reader = await open(tokenPath, "r");
    setTimeout(() => void reader.close(), 50);
    const fresh = await writeLinkToken(tokenPath);
    await expect(readLinkToken(tokenPath)).resolves.toBe(fresh);
  });

  it("authenticates both ends, then carries events and commands", async () => {
    const link = startClient();
    await waitFor(() => link.connected && hostCount === 1);

    const complete: HostEvent = {
      type: "collection-complete",
      sessionId: "2026-01-01T10-00-00-000Z-ab12",
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 120,
      responseCount: 9,
    };
    expect(link.send(complete)).toBe(true);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual(complete);

    expect(server.send({ type: "start-collection", target: 250 })).toBe(true);
    await waitFor(() => commands.length === 1);
    expect(commands[0]).toEqual({ type: "start-collection", target: 250 });
  });

  it("drops schema-invalid events after the handshake", async () => {
    const link = startClient();
    await waitFor(() => link.connected);
    // An unsafe session id (path traversal) must never reach the desktop.
    expect(
      link.send({
        type: "collection-complete",
        sessionId: "..\\..\\evil",
        mode: "A",
        reason: "x",
        uniquePostCount: 1,
        responseCount: 1,
      } as HostEvent),
    ).toBe(true);
    link.send({ type: "collection-start-result", outcome: "mode-b-off" });
    await waitFor(() => events.length === 1);
    expect(events).toEqual([{ type: "collection-start-result", outcome: "mode-b-off" }]);
  });

  it("refuses a desktop that cannot prove the token (pipe squatting)", async () => {
    await writeLinkToken(tokenPath); // the host now holds a different token
    const states: boolean[] = [];
    client = new LinkClient({
      path,
      tokenPath,
      retryMs: 10_000,
      onCommand: (command) => commands.push(command),
      onConnectionChanged: (connected) => states.push(connected),
    });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.connected).toBe(false);
    expect(hostCount).toBe(0);
    expect(states).toEqual([]);
  });

  it("never authenticates a peer with a wrong proof and tells it nothing", async () => {
    const socket = connect(path);
    const decoder = new MessageDecoder();
    const received: unknown[] = [];
    socket.on("data", (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) received.push(JSON.parse(raw));
    });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(encodeMessage({ type: "hello", protocol: 1, nonce: newNonce() }));
    await waitFor(() => received.length === 1);
    socket.write(
      encodeMessage({ type: "auth", proof: linkProof("f".repeat(64), "host", "0") }),
    );
    await new Promise((resolve) => socket.once("close", resolve));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "welcome" });
    expect(hostCount).toBe(0);
  });

  it("drops a silent peer after the handshake timeout", async () => {
    const socket = connect(path);
    await new Promise((resolve) => socket.once("connect", resolve));
    await new Promise((resolve) => socket.once("close", resolve));
    expect(hostCount).toBe(0);
  });

  it("drops a silent desktop peer after the handshake timeout and tries again", async () => {
    await server.close();
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    try {
      client = new LinkClient({
        path,
        tokenPath,
        retryMs: 10,
        handshakeTimeoutMs: 50,
        onCommand: (command) => commands.push(command),
      });
      client.start();
      // The first connection was dropped by the client, a second one followed.
      await waitFor(() => sockets.length >= 2);
      expect(client.connected).toBe(false);
    } finally {
      client?.close();
      client = null;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("reconnects when the desktop app starts after the host", async () => {
    await server.close();
    const link = startClient(30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(link.connected).toBe(false);
    token = await writeLinkToken(tokenPath);
    server = new LinkServer({
      path,
      token,
      onEvent: (event) => events.push(event),
      onHostsChanged: (count) => (hostCount = count),
    });
    await server.listen();
    await waitFor(() => link.connected && hostCount === 1);
  });

  it("backs off exponentially while the desktop app is away, then resets", async () => {
    await server.close();
    client = new LinkClient({
      path,
      tokenPath,
      retryMs: 10,
      maxRetryMs: 40,
      onCommand: (command) => commands.push(command),
    });
    client.start();
    await waitFor(() => client?.retryDelayMs === 40);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.retryDelayMs).toBe(40);
    server = new LinkServer({ path, token, onEvent: (event) => events.push(event) });
    await server.listen();
    await waitFor(() => client?.connected === true);
    expect(client.retryDelayMs).toBe(10);
  });

  it("reports nothing sent while the desktop app is away", async () => {
    await server.close();
    const link = startClient(10_000);
    expect(link.send({ type: "collection-start-result", outcome: "busy" })).toBe(false);
  });

  it("counts a host as gone when its process closes the connection", async () => {
    const link = startClient();
    await waitFor(() => hostCount === 1);
    link.close();
    await waitFor(() => hostCount === 0);
    expect(server.send({ type: "start-collection" })).toBe(false);
  });
});
