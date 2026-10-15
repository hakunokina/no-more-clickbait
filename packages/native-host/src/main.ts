import type { BridgeReply } from "@nmc/core";
import { CaptureStore } from "./capture-store.js";
import { LinkClient } from "./desktop-link.js";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";
import { PostSessionStore } from "./post-session-store.js";
import { saveSyncedSettings } from "./settings-store.js";

/**
 * Native Messaging host entry point. The browser launches this process
 * and speaks length-prefixed JSON over stdin/stdout. stdout is reserved
 * for protocol frames — all diagnostics go to stderr, counts only.
 *
 * - Validated post batches land in the collection session folder
 *   (post-session-store.ts, `%LOCALAPPDATA%\NoMoreClickbait\sessions`);
 *   `collection-complete` closes it and tells the desktop app.
 * - The extension's long-lived port opens with a `ping`; only then does
 *   this process link up with the desktop app over the user-only pipe
 *   (desktop-link.ts), so one-shot hosts (settings sync) never do. The
 *   link carries the desktop's `start-collection` to the extension and
 *   `link-status` pushes whenever the desktop comes or goes.
 * - Raw developer captures go through the CaptureStore (capture-store.ts):
 *   outside the repo, per-session folders with a counts/times-only
 *   summary.json (`NMC_INBOX_DIR` moves them).
 */
const captureStore = new CaptureStore();
const sessionStore = new PostSessionStore();
let link: LinkClient | null = null;

function pushToExtension(message: BridgeReply): void {
  process.stdout.write(encodeMessage(message));
}

function startDesktopLink(): void {
  if (link) return;
  link = new LinkClient({
    onCommand: (command) => {
      pushToExtension({
        type: "start-collection",
        ...(command.target !== undefined ? { target: command.target } : {}),
      });
    },
    onConnectionChanged: (desktopConnected) => {
      pushToExtension({ type: "link-status", desktopConnected, extensionConnected: true });
    },
    log: (line) => process.stderr.write(`native-host: ${line}\n`),
  });
  link.start();
  // The extension learns the state right away, not only on changes.
  pushToExtension({ type: "link-status", desktopConnected: false, extensionConnected: true });
}

const decoder = new MessageDecoder();

/**
 * In-flight message handlers. When stdin closes the process must not
 * die before these settle — a browser that sends a batch and closes
 * the port right away would otherwise lose its last write.
 */
const pending = new Set<Promise<void>>();

function dispatch(raw: string): void {
  const task = handleBridgeMessage(raw, {
    onPing: startDesktopLink,
    onPostBatch: async (batch) => {
      if (!(await sessionStore.addBatch(batch))) {
        process.stderr.write("native-host: batch after collection-complete dropped\n");
      }
    },
    onCollectionComplete: async ({ mode, reason, uniquePostCount, responseCount }) => {
      const sessionId = await sessionStore.complete({
        mode,
        reason,
        uniquePostCount,
        responseCount,
      });
      // Desktop closed: it finds the complete session on disk at its next start.
      link?.send({
        type: "collection-complete",
        sessionId,
        mode,
        reason,
        uniquePostCount,
        responseCount,
      });
    },
    onCollectionStartResult: (result) => {
      link?.send(result);
    },
    onRawCapture: async (capture) => ({ sequence: await captureStore.store(capture) }),
    onOversizedCapture: (capture) => captureStore.recordOversized(capture),
    captureStats: () => captureStore.stats,
    onModeBRun: (run) => captureStore.recordModeBRun(run),
    onSettingsSync: (settings) => saveSyncedSettings(settings),
  })
    .then((reply) => {
      process.stdout.write(encodeMessage(reply));
    })
    .catch((error: unknown) => {
      process.stderr.write(`native-host: handler error: ${String(error)}\n`);
      process.stdout.write(encodeMessage({ type: "error", message: "internal host error" }));
    })
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

process.stdin.on("data", (chunk: Buffer) => {
  let raws: string[];
  try {
    raws = decoder.push(chunk);
  } catch (error) {
    process.stderr.write(`native-host: framing error: ${String(error)}\n`);
    process.exit(1);
    return;
  }
  for (const raw of raws) dispatch(raw);
});

process.stdin.on("end", () => {
  void (async () => {
    // Drain in-flight handlers (file writes) before exiting; handlers
    // never enqueue new ones, so one settle pass is enough.
    await Promise.allSettled([...pending]);
    link?.close();
    process.exit(0);
  })();
});
