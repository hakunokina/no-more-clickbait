import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CollectionProgressSchema,
  CollectionStartResultSchema,
  CollectSourceOutcomeSchema,
  ManagedSettingKeySchema,
  ManagedSettingsSchema,
  SettingsStampSchema,
  SiteCollectOutcomeSchema,
  UiLangSchema,
} from "@nmc/core";
import {
  BrowserIdentitySchema,
  UNKNOWN_BROWSER,
  type BrowserIdentity,
} from "./browser-identity.js";
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
  // Tests run a second link next to the user's real one.
  const override = env["NMC_LINK_PIPE"];
  if (override) return override;
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
  /** Distinct posts the collection was working towards. */
  target: z.number().int().min(1).max(10_000).optional(),
  /** Custom sites collected alongside X, one outcome each. */
  sites: z.array(SiteCollectOutcomeSchema).max(100).optional(),
  /** Each scrolled feed's outcome, when the collection was not X alone. */
  sources: z.array(CollectSourceOutcomeSchema).max(2).optional(),
});
export type CollectionCompleteEvent = z.infer<typeof CollectionCompleteEventSchema>;

/** The extension's answer to start-collection, relayed as is. */
export const CollectionStartResultEventSchema = CollectionStartResultSchema;
export type CollectionStartResultEvent = z.infer<typeof CollectionStartResultEventSchema>;

/** A Mode B run's count so far, relayed as is. */
export const CollectionProgressEventSchema = CollectionProgressSchema;
export type CollectionProgressEvent = z.infer<typeof CollectionProgressEventSchema>;

/**
 * The settings the extension holds, relayed when it reports them (on
 * connecting, `origin: "sync"`) or answers a desktop push. `saved`:
 * settings.json now holds them (false: it already held a later save).
 */
export const SettingsStateEventSchema = z.object({
  type: z.literal("settings-state"),
  origin: z.enum(["sync", "push-result"]),
  settings: ManagedSettingsSchema,
  stamp: SettingsStampSchema,
  saved: z.boolean(),
  /** push-result: whether the push was applied or the extension's own save was later. */
  outcome: z.enum(["applied", "kept-newer"]).optional(),
  modeBPermissionMissing: z.boolean().optional(),
  /**
   * Settings the extension did not send: it is older than this app and
   * does not know them, so `settings` holds their defaults.
   */
  extensionMissing: z.array(ManagedSettingKeySchema).optional(),
});
export type SettingsStateEvent = z.infer<typeof SettingsStateEventSchema>;

/** Host -> desktop events after the handshake. */
export const HostEventSchema = z.discriminatedUnion("type", [
  CollectionCompleteEventSchema,
  CollectionStartResultEventSchema,
  CollectionProgressEventSchema,
  SettingsStateEventSchema,
]);
export type HostEvent = z.infer<typeof HostEventSchema>;

/** Desktop -> host commands after the handshake. */
export const DesktopCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start-collection"),
    target: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({ type: z.literal("stop-collection") }),
  /** Settings changed in the desktop app, for the extension to apply. */
  z.object({
    type: z.literal("settings-push"),
    settings: ManagedSettingsSchema,
    stamp: SettingsStampSchema,
  }),
  /** The language the desktop app shows, for extensions set to "system". */
  z.object({ type: z.literal("ui-lang"), lang: UiLangSchema }),
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
/** `browser`: where the host runs (hosts built before it send none). */
const AuthSchema = z.object({
  type: z.literal("auth"),
  proof: ProofSchema,
  browser: BrowserIdentitySchema.optional(),
});
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
  await renameRetrying(temp, path);
  return token;
}

/**
 * Windows refuses to replace a file another process has open (EPERM):
 * a host re-reading the token while the desktop app starts, or a virus
 * scanner. Such handles live for milliseconds, so retry briefly instead
 * of failing the app's whole link for this start.
 */
async function renameRetrying(from: string, to: string, budgetMs = 2_000): Promise<void> {
  const started = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy || Date.now() - started > budgetMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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

  /** Flushes what was written, then closes (bounded: a stuck peer is cut off). */
  end(timeoutMs: number): Promise<void> {
    if (this.#socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#socket.destroy(), timeoutMs);
      timer.unref?.();
      this.#socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#socket.end();
    });
  }
}

/** An authenticated host as the desktop sees it. */
export interface LinkedHost {
  /** Unknown (`other`) for hosts that did not say. */
  browser: BrowserIdentity;
}

export interface LinkServerOptions {
  path: string;
  token: string;
  onEvent(event: HostEvent, from: LinkedHost): void;
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
  readonly #hosts: { connection: FramedConnection; info: LinkedHost }[] = [];

  constructor(options: LinkServerOptions) {
    this.#options = options;
  }

  get hostCount(): number {
    return this.#hosts.length;
  }

  /** The connected hosts, most recent last. */
  get hosts(): LinkedHost[] {
    return this.#hosts.map((host) => host.info);
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

  /**
   * Sends a command to the most recently connected host — of those
   * `accept` takes, when given (e.g. one browser's).
   */
  send(command: DesktopCommand, accept?: (host: LinkedHost) => boolean): boolean {
    const host = this.#hosts.filter((candidate) => accept?.(candidate.info) ?? true).pop();
    return host ? host.connection.send(command) : false;
  }

  /** Sends a command to every connected host; returns how many took it. */
  broadcast(command: DesktopCommand): number {
    return this.#hosts.filter((host) => host.connection.send(command)).length;
  }

  close(): Promise<void> {
    for (const host of [...this.#hosts]) host.connection.close();
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
    const info: LinkedHost = { browser: UNKNOWN_BROWSER };
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
          if (auth.data.browser) info.browser = auth.data.browser;
          connection.send({ type: "ready" });
          this.#hosts.push({ connection, info });
          this.#options.onHostsChanged?.(this.#hosts.length);
          return;
        }
        const event = HostEventSchema.safeParse(message);
        if (event.success) this.#options.onEvent(event.data, info);
      },
      () => {
        clearTimeout(timer);
        const index = this.#hosts.findIndex((host) => host.connection === connection);
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
  /** Where this host runs, told to the desktop in the handshake. */
  browser?: BrowserIdentity | Promise<BrowserIdentity>;
  /**
   * First delay between connection attempts while the desktop app is
   * closed; it doubles per failed attempt up to `maxRetryMs` and resets
   * once a link stands.
   */
  retryMs?: number;
  maxRetryMs?: number;
  /**
   * A peer that accepts the connection but never finishes the handshake
   * (a squatter on the pipe name, a hung desktop app) is dropped after
   * this long and the next attempt is scheduled.
   */
  handshakeTimeoutMs?: number;
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

  /**
   * Stops for good. What was already sent is flushed first: the host
   * process exits right after, and an event still in the socket's
   * buffer (e.g. the last collection-complete) would be lost.
   */
  close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    return this.#connection?.end(1_000) ?? Promise.resolve();
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
    const browser = await this.#options.browser;
    if (this.#closed || this.#connection) return;
    const socket = connect(this.#options.path ?? desktopPipePath());
    const ownNonce = newNonce();
    let state: "welcome" | "ready" | "open" = "welcome";
    const timer = setTimeout(() => {
      this.#options.log?.("desktop link: no handshake from the peer; disconnecting");
      connection.close();
    }, this.#options.handshakeTimeoutMs ?? 5_000);
    timer.unref?.();
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
            ...(browser ? { browser } : {}),
          });
          state = "ready";
          return;
        }
        if (state === "ready") {
          if (!ReadySchema.safeParse(message).success) return connection.close();
          clearTimeout(timer);
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
        clearTimeout(timer);
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
