import type { BridgeMessage } from "@nmc/core";

/** The part of chrome.runtime.Port the channel drives (tests fake it). */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
}

/** Host messages that answer nothing: the desktop's pushes. */
const PUSHES: ReadonlySet<string> = new Set(["start-collection", "link-status", "settings-push"]);

function isPush(reply: unknown): boolean {
  const type = (reply as { type?: unknown } | null)?.type;
  return typeof type === "string" && PUSHES.has(type);
}

export const RETIRE_TIMEOUT_MS = 15_000;

/**
 * The worker's long-lived native port. Every message it sends gets
 * exactly one reply from the host, so the channel knows what is still
 * unanswered on a port.
 *
 * A new host session (= a new host process) starts by retiring the
 * current port: later messages open a new one, and the old one is
 * closed only once its host has answered everything sent on it (or
 * after `retireTimeoutMs`). Closing it right away cut off a host that
 * was still storing the last batch and the collection-complete — the
 * session never got its complete.json.
 */
export class NativeChannel<P extends NativePort> {
  readonly #open: () => P;
  readonly #retireTimeoutMs: number;
  #port: P | null = null;
  readonly #unanswered = new Map<P, number>();
  readonly #retiring = new Map<P, ReturnType<typeof setTimeout>>();

  /** `open` connects and wires the port's listeners to `received`/`lost`. */
  constructor(open: () => P, retireTimeoutMs: number = RETIRE_TIMEOUT_MS) {
    this.#open = open;
    this.#retireTimeoutMs = retireTimeoutMs;
  }

  get current(): P | null {
    return this.#port;
  }

  /** The open port; a new one opens with a `ping`. Throws when the host cannot start. */
  port(): P {
    if (this.#port) return this.#port;
    const opened = this.#open();
    this.#port = opened;
    this.#unanswered.set(opened, 0);
    try {
      this.#post(opened, { type: "ping" });
    } catch (error) {
      this.lost(opened);
      throw error;
    }
    return opened;
  }

  /** False when no host could be reached (the message is dropped). */
  send(message: BridgeMessage): boolean {
    let port: P | null = null;
    try {
      port = this.port();
      this.#post(port, message);
      return true;
    } catch {
      if (port) this.lost(port);
      return false;
    }
  }

  /** Every message the host sent on `port` goes through here. */
  received(port: P, reply: unknown): void {
    if (isPush(reply)) return;
    const left = Math.max(0, (this.#unanswered.get(port) ?? 0) - 1);
    this.#unanswered.set(port, left);
    if (left === 0 && this.#retiring.has(port)) this.#close(port);
  }

  /** The port closed or broke; true when it was the current one. */
  lost(port: P): boolean {
    this.#forget(port);
    if (this.#port !== port) return false;
    this.#port = null;
    return true;
  }

  /** Starts a new host session (see the class comment). */
  retire(): void {
    const port = this.#port;
    if (!port) return;
    this.#port = null;
    if ((this.#unanswered.get(port) ?? 0) === 0) {
      this.#close(port);
      return;
    }
    this.#retiring.set(
      port,
      setTimeout(() => this.#close(port), this.#retireTimeoutMs),
    );
  }

  #post(port: P, message: BridgeMessage): void {
    port.postMessage(message);
    this.#unanswered.set(port, (this.#unanswered.get(port) ?? 0) + 1);
  }

  #close(port: P): void {
    this.#forget(port);
    try {
      port.disconnect();
    } catch {
      // Already gone.
    }
  }

  #forget(port: P): void {
    clearTimeout(this.#retiring.get(port));
    this.#retiring.delete(port);
    this.#unanswered.delete(port);
  }
}
