import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CollectionStartResultSchema } from "@nmc/core";
import { encodeMessage, MessageDecoder } from "./framing.js";

/**
 * Host <-> desktop link: a local IPC channel between the browser-launched
 * native host process and the desktop app. Windows: a named pipe
 * (`\\.\pipe\no-more-clickbait-<user>`), elsewhere a Unix socket in the
 * user's data dir. No TCP port anywhere.
 *
 * Control plane only. Collected posts never cross this channel: the
 * host writes them to the session folder on disk (post-session-store.ts)
 * and the link carries commands and "this session is complete" events.
 *
 * Why a handshake: Node creates the pipe with the default security
 * descriptor, whose DACL (measured on Windows 11) grants Everyone and
 * ANONYMOUS LOGON *read* access besides full control to the owner,
 * SYSTEM and Administrators; Node cannot set a custom DACL. So both
 * ends prove knowledge of a per-start random token kept in the user's
 * own %LOCALAPPDATA% (user-only ACL) before anything else is said:
 * - another account cannot write, so it can never authenticate, and the
 *   server says nothing but `welcome` to an unauthenticated peer;
 * - another account squatting the pipe name cannot prove the token, so
 *   the host never talks to an impostor desktop.
 */

export const LINK_PROTOCOL_VERSION = 1;
export const DESKTOP_DATA_DIRNAME = "NoMoreClickbait";

/** `%LOCALAPPDATA%\NoMoreClickbait` (shared with install-host.ps1). */
export function desktopDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env["LOCALAPPDATA"];
  return localAppData
    ? join(localAppData, DESKTOP_DATA_DIRNAME)
    : join(homedir(), ".local", "share", DESKTOP_DATA_DIRNAME);
}

export function linkTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "link-token");
}

export function desktopPipePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  user: string = userInfo().username,
): string {
  if (platform !== "win32") return join(desktopDataDir(env), "link.sock");
  const safeUser = user.replace(/[^A-Za-z0-9._-]/g, "_") || "user";
  return `\\\\.\\pipe\\no-more-clickbait-${safeUser}`;
}

/** Host session ids double as folder names: validate before any path use. */
export const SessionIdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}$/);

const NonceSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ProofSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A finished collection whose posts sit in a session folder. */
export const CollectionCompleteEventSchema = z.object({
  type: z.literal("collection-complete"),
  /** Null when the collection ended without a single stored batch. */
  sessionId: SessionIdSchema.nullable(),
  mode: z.enum(["A", "B"]),
  reason: z.string().max(64),
  uniquePostCount: z.number().int().nonnegative(),
  responseCount: z.number().int().nonnegative(),
});
export type CollectionCompleteEvent = z.infer<typeof CollectionCompleteEventSchema>;

/** The extension's answer to start-collection, relayed as is. */
export const CollectionStartResultEventSchema = CollectionStartResultSchema;
export type CollectionStartResultEvent = z.infer<typeof CollectionStartResultEventSchema>;

/** Host -> desktop events after the handshake. */
export const HostEventSchema = z.discriminatedUnion("type", [
  CollectionCompleteEventSchema,
  CollectionStartResultEventSchema,
]);
export type HostEvent = z.infer<typeof HostEventSchema>;

/** Desktop -> host commands after the handshake. */
export const DesktopCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start-collection"),
    target: z.number().int().min(1).max(10_000).optional(),
  }),
]);
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;

const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(LINK_PROTOCOL_VERSION),
  nonce: NonceSchema,
});
const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  protocol: z.literal(LINK_PROTOCOL_VERSION),
  nonce: NonceSchema,
  proof: ProofSchema,
});
const AuthSchema = z.object({ type: z.literal("auth"), proof: ProofSchema });
const ReadySchema = z.object({ type: z.literal("ready") });

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

/** HMAC proving knowledge of the token for one role and one peer nonce. */
export function linkProof(token: string, role: "host" | "desktop", nonce: string): string {
  return createHmac("sha256", token).update(`nmc-link:${role}:${nonce}`).digest("hex");
}

function proofMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Writes a fresh random token (called by the desktop app on every start). */
export async function writeLinkToken(path: string = linkTokenPath()): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, token, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return token;
}

export async function readLinkToken(path: string = linkTokenPath()): Promise<string | null> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * One framed JSON connection. Frames use the native-messaging layout
 * (4-byte LE length + UTF-8 JSON); a malformed frame closes the socket.
 */
class FramedConnection {
  readonly #socket: Socket;
  readonly #decoder = new MessageDecoder();

  constructor(socket: Socket, onMessage: (message: unknown) => void, onClose: () => void) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      let raws: string[];
      try {
        raws = this.#decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of raws) {
        if (socket.destroyed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          socket.destroy();
          return;
        }
        onMessage(parsed);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", onClose);
  }

  send(message: unknown): boolean {
    if (this.#socket.destroyed) return false;
    this.#socket.write(encodeMessage(message));
    return true;
  }

  close(): void {
    this.#socket.destroy();
  }
}

export interface LinkServerOptions {
  path: string;
  token: string;
  onEvent(event: HostEvent): void;
  /** Number of authenticated hosts changed. */
  onHostsChanged?(count: number): void;
  /** Peers that fail the handshake are dropped without this many ms. */
  handshakeTimeoutMs?: number;
}

/** Desktop side: listens on the pipe and authenticates every host. */
export class LinkServer {
  readonly #options: LinkServerOptions;
  #server: Server | null = null;
  /** Authenticated hosts, most recent last. */
  readonly #hosts: FramedConnection[] = [];

  constructor(options: LinkServerOptions) {
    this.#options = options;
  }

  get hostCount(): number {
    return this.#hosts.length;
  }

  async listen(): Promise<void> {
    // A Unix socket file outlives a crashed app; a Windows pipe does not.
    // The desktop app holds a single-instance lock, so this is never live.
    if (process.platform !== "win32") await rm(this.#options.path, { force: true });
    await mkdir(dirname(this.#options.path), { recursive: true }).catch(() => undefined);
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket));
      server.once("error", reject);
      server.listen(this.#options.path, () => {
        server.off("error", reject);
        this.#server = server;
        resolve();
      });
    });
  }

  /** Sends a command to the most recently connected host. */
  send(command: DesktopCommand): boolean {
    const host = this.#hosts[this.#hosts.length - 1];
    return host ? host.send(command) : false;
  }

  close(): Promise<void> {
    for (const host of [...this.#hosts]) host.close();
    return new Promise((resolve) => {
      if (!this.#server) resolve();
      else this.#server.close(() => resolve());
      this.#server = null;
    });
  }

  #accept(socket: Socket): void {
    const { token } = this.#options;
    const ownNonce = newNonce();
    let state: "hello" | "auth" | "ready" = "hello";
    const timer = setTimeout(() => {
      if (state !== "ready") socket.destroy();
    }, this.#options.handshakeTimeoutMs ?? 5_000);

    const connection = new FramedConnection(
      socket,
      (message) => {
        if (state === "hello") {
          const hello = HelloSchema.safeParse(message);
          if (!hello.success) return connection.close();
          connection.send({
            type: "welcome",
            protocol: LINK_PROTOCOL_VERSION,
            nonce: ownNonce,
            proof: linkProof(token, "desktop", hello.data.nonce),
          });
          state = "auth";
          return;
        }
        if (state === "auth") {
          const auth = AuthSchema.safeParse(message);
          if (
            !auth.success ||
            !proofMatches(linkProof(token, "host", ownNonce), auth.data.proof)
          ) {
            return connection.close();
          }
          state = "ready";
          clearTimeout(timer);
          connection.send({ type: "ready" });
          this.#hosts.push(connection);
          this.#options.onHostsChanged?.(this.#hosts.length);
          return;
        }
        const event = HostEventSchema.safeParse(message);
        if (event.success) this.#options.onEvent(event.data);
      },
      () => {
        clearTimeout(timer);
        const index = this.#hosts.indexOf(connection);
        if (index >= 0) {
          this.#hosts.splice(index, 1);
          this.#options.onHostsChanged?.(this.#hosts.length);
        }
      },
    );
  }
}

export interface LinkClientOptions {
  path?: string;
  tokenPath?: string;
  onCommand(command: DesktopCommand): void;
  onConnectionChanged?(connected: boolean): void;
  /**
   * First delay between connection attempts while the desktop app is
   * closed; it doubles per failed attempt up to `maxRetryMs` and resets
   * once a link stands.
   */
  retryMs?: number;
  maxRetryMs?: number;
  /** Diagnostics only (stderr); never feed content. */
  log?(line: string): void;
}

/**
 * Host side: keeps trying to reach the desktop app while the host process
 * lives, re-reading the token on every attempt (the desktop writes a new
 * one per start).
 */
export class LinkClient {
  readonly #options: LinkClientOptions;
  #connection: FramedConnection | null = null;
  #ready = false;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #delayMs: number;

  constructor(options: LinkClientOptions) {
    this.#options = options;
    this.#delayMs = options.retryMs ?? 5_000;
  }

  /** Delay before the next attempt (exposed for tests). */
  get retryDelayMs(): number {
    return this.#delayMs;
  }

  get connected(): boolean {
    return this.#ready;
  }

  start(): void {
    void this.#attempt();
  }

  /** False when the desktop app is not connected (nothing is queued). */
  send(event: HostEvent): boolean {
    return this.#ready && this.#connection !== null && this.#connection.send(event);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#connection?.close();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    const delay = this.#delayMs;
    this.#delayMs = Math.min(delay * 2, this.#options.maxRetryMs ?? 60_000);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#attempt();
    }, delay);
    this.#timer.unref?.();
  }

  async #attempt(): Promise<void> {
    if (this.#closed || this.#connection) return;
    const token = await readLinkToken(this.#options.tokenPath ?? linkTokenPath());
    if (!token || this.#closed) return this.#retry();
    const socket = connect(this.#options.path ?? desktopPipePath());
    const ownNonce = newNonce();
    let state: "welcome" | "ready" | "open" = "welcome";
    const connection = new FramedConnection(
      socket,
      (message) => {
        if (state === "welcome") {
          const welcome = WelcomeSchema.safeParse(message);
          if (
            !welcome.success ||
            !proofMatches(linkProof(token, "desktop", ownNonce), welcome.data.proof)
          ) {
            this.#options.log?.("desktop link: peer failed the handshake; disconnecting");
            return connection.close();
          }
          connection.send({
            type: "auth",
            proof: linkProof(token, "host", welcome.data.nonce),
          });
          state = "ready";
          return;
        }
        if (state === "ready") {
          if (!ReadySchema.safeParse(message).success) return connection.close();
          state = "open";
          this.#ready = true;
          this.#delayMs = this.#options.retryMs ?? 5_000;
          this.#options.onConnectionChanged?.(true);
          return;
        }
        const command = DesktopCommandSchema.safeParse(message);
        if (command.success) this.#options.onCommand(command.data);
      },
      () => {
        const wasReady = this.#ready;
        this.#ready = false;
        this.#connection = null;
        if (wasReady) this.#options.onConnectionChanged?.(false);
        this.#retry();
      },
    );
    this.#connection = connection;
    socket.on("connect", () => {
      connection.send({ type: "hello", protocol: LINK_PROTOCOL_VERSION, nonce: ownNonce });
    });
  }
}
