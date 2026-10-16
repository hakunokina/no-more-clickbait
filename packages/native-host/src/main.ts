import { UNSTAMPED, type BridgeReply, type CaptureSource } from "@nmc/core";
import { identifyBrowser, type BrowserIdentity } from "./browser-identity.js";
import { CaptureStore } from "./capture-store.js";
import { createCollectionRelay } from "./collection-relay.js";
import { LinkClient } from "./desktop-link.js";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";
import { PostSessionStore } from "./post-session-store.js";
import { saveSettingsFile } from "./settings-store.js";

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
 *   `link-status` pushes whenever the desktop comes or goes. The host
 *   tells the desktop which browser started it (browser-identity.ts).
 * - Settings: the host is settings.json's only writer. A save in the
 *   extension (`settings-sync`) or its answer to a desktop change
 *   (`settings-push` → `settings-push-result`) is written unless the
 *   file holds a later save, and relayed to the desktop.
 * - Raw developer captures go through the CaptureStore (capture-store.ts):
 *   outside the repo, per-session folders with a counts/times-only
 *   summary.json (`NMC_INBOX_DIR` moves them). Each source (X, Reddit, Instagram)
 *   has its own store and folder.
 * - The browser closes stdin and stdout together when the port closes.
 *   Messages already received are still handled (their files written,
 *   the desktop told); only the replies have nowhere to go. A write to
 *   the closed stdout fails with EPIPE, which must not kill the process
 *   before that work is done.
 */
const captureStores = new Map<CaptureSource, CaptureStore>();

function captureStore(source: CaptureSource = "x"): CaptureStore {
  let store = captureStores.get(source);
  if (!store) {
    store = new CaptureStore(undefined, undefined, source);
    captureStores.set(source, store);
  }
  return store;
}
const sessionStore = new PostSessionStore();
let link: LinkClient | null = null;
let browserGone = false;
/** Asked once and only by the long-lived port (one-shot hosts spawn nothing). */
let browserIdentity: Promise<BrowserIdentity> | null = null;

function hostBrowser(): Promise<BrowserIdentity> {
  browserIdentity ??= identifyBrowser();
  return browserIdentity;
}

process.stdout.on("error", () => {
  browserGone = true;
});

function pushToExtension(message: BridgeReply): void {
  if (browserGone || process.stdout.destroyed) return;
  process.stdout.write(encodeMessage(message));
}

function startDesktopLink(): void {
  if (link) return;
  link = new LinkClient({
    browser: hostBrowser(),
    // Desktop commands are extension pushes of the same shape.
    onCommand: pushToExtension,
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

const relay = createCollectionRelay(
  sessionStore,
  (message) => link?.send(message),
  () => hostBrowser().then((identity) => identity.family),
);

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
    onFeedBatch: async (batch) => {
      const stored = await sessionStore.addFeedBatch(batch);
      if (stored === 0 && batch.items.length > 0) {
        process.stderr.write("native-host: feed batch after collection-complete dropped\n");
      }
      return stored;
    },
    onCollectionComplete: async ({
      mode,
      reason,
      uniquePostCount,
      responseCount,
      target,
      sites,
      sources,
    }) => {
      const counts = {
        mode,
        reason,
        uniquePostCount,
        responseCount,
        ...(target !== undefined ? { target } : {}),
        ...(sites !== undefined ? { sites } : {}),
        ...(sources !== undefined ? { sources } : {}),
      };
      const sessionId = await sessionStore.complete(counts);
      // Desktop closed: it finds the complete session on disk at its next start.
      link?.send({
        type: "collection-complete",
        sessionId,
        ...counts,
      });
    },
    onCollectionStartResult: relay.onCollectionStartResult,
    onCollectionProgress: relay.onCollectionProgress,
    onRawCapture: async (capture) => ({
      sequence: await captureStore(capture.source).store(capture),
    }),
    onOversizedCapture: (capture) => captureStore(capture.source).recordOversized(capture),
    captureStats: (source) => captureStore(source).stats,
    onModeBRun: (run) => captureStore().recordModeBRun(run),
    onSettingsSync: async (settings, stamp, missing) => {
      const file = await saveSettingsFile(settings, stamp);
      link?.send({
        type: "settings-state",
        origin: "sync",
        settings,
        stamp: stamp ?? UNSTAMPED,
        saved: file.written,
        ...(missing.length > 0 ? { extensionMissing: missing } : {}),
      });
    },
    onSettingsPushResult: async (
      { outcome, settings, stamp, modeBPermissionMissing },
      missing,
    ) => {
      const file = await saveSettingsFile(settings, stamp);
      link?.send({
        type: "settings-state",
        origin: "push-result",
        outcome,
        settings,
        stamp,
        saved: file.written,
        ...(modeBPermissionMissing !== undefined ? { modeBPermissionMissing } : {}),
        ...(missing.length > 0 ? { extensionMissing: missing } : {}),
      });
    },
  })
    .then((reply) => {
      pushToExtension(reply);
    })
    .catch((error: unknown) => {
      process.stderr.write(`native-host: handler error: ${String(error)}\n`);
      pushToExtension({ type: "error", message: "internal host error" });
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
    await link?.close();
    process.exit(0);
  })();
});
