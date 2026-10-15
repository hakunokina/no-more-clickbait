import {
  bridgeMessageByteLength,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseHomeTimeline,
  type BridgeMessage,
  type BridgeReply,
  type CaptureStats,
  type PostBatch,
  type Settings,
} from "@nmc/core";
import { CaptureSession } from "./capture-session.js";
import { isWorkerCaptureMessage, type WorkerCaptureMessage } from "./messages.js";
import { loadSettings, SETTINGS_STORAGE_KEY } from "./settings.js";

/**
 * Service worker: receives captured timeline responses, converts them
 * to Post batches and hands them to the desktop app through Native
 * Messaging (no TCP port; the browser launches the host process).
 *
 * Developer capture (opt-in, OFF by default): raw response bodies are
 * forwarded verbatim to the host, which stores them outside the repo
 * with a counts/times-only summary.
 *
 * Badge = distinct organic posts (no ads, no repeats across responses).
 * With developer capture ON the host's `uniquePostCount` is the single
 * source — it owns the dumps, so it is what was really captured — and
 * it alone drives the one-shot target notification (capture keeps
 * going). With capture OFF the worker's own session counter is shown.
 * Toggling developer capture starts a new counting session.
 *
 * Mode B (auto-scroll a hidden tab until enough posts are gathered) is
 * intentionally only a guarded switch in this skeleton: it stays OFF
 * unless the user opts in on the options page, and the scrolling
 * implementation lands separately with its risks documented.
 */

export const NATIVE_HOST_NAME = "io.github.hakunokina.no_more_clickbait";

const CAPTURE_NOTIFICATION_ID = "nmc-capture-target";

let port: chrome.runtime.Port | null = null;
const session = new CaptureSession(chrome.storage.session);

function nativePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.onMessage.addListener((reply: BridgeReply) => {
    void handleReply(reply);
  });
  return port;
}

function sendToDesktop(message: BridgeMessage): boolean {
  try {
    nativePort().postMessage(message);
    return true;
  } catch {
    port = null;
    return false;
  }
}

async function updateBadge(count: number): Promise<void> {
  await chrome.action.setBadgeText({ text: count === 0 ? "" : String(count) });
}

async function handleReply(reply: BridgeReply): Promise<void> {
  if (reply.type === "capture-accepted" || reply.type === "capture-rejected") {
    if (reply.type === "capture-rejected") {
      console.error(`[nmc] developer capture refused: ${reply.message}`);
    }
    await reflectCaptureStats(reply.stats);
  } else if (reply.type === "error") {
    console.error(`[nmc] native host error: ${reply.message}`);
  }
}

async function reflectCaptureStats(stats: CaptureStats): Promise<void> {
  const settings = await loadSettings().catch(() => null);
  if (!settings?.devCaptureEnabled) return;
  await updateBadge(stats.uniquePostCount);
  if (!(await session.reachedTarget(stats.uniquePostCount, settings.captureTarget))) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#137333" });
  try {
    await chrome.notifications.create(CAPTURE_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: "No More Clickbait — capture target reached",
      message:
        `${stats.uniquePostCount} distinct posts captured in ${stats.responseCount} timeline responses ` +
        `(target ${settings.captureTarget}). Capture continues; turn it off in Options to stop.`,
    });
  } catch {
    // Notification is best-effort; the badge already shows the state.
  }
}

/**
 * Forwards one raw body to the host for developer capture. Bodies that
 * would exceed the bridge frame ceiling are never chunked: they are
 * refused with a small counter message and an explicit error in the
 * service-worker console (mirrored in the session summary).
 */
function forwardDevCapture(message: WorkerCaptureMessage): void {
  const capturedAt = new Date().toISOString();
  const capture: BridgeMessage = {
    type: "raw-capture",
    operation: message.operation,
    capturedAt,
    bodyText: message.bodyText,
  };
  const framedBytes = bridgeMessageByteLength(capture);
  if (framedBytes > MAX_BRIDGE_MESSAGE_BYTES) {
    console.error(
      `[nmc] developer capture: ${message.operation} response is ${framedBytes} bytes framed, ` +
        `over the ${MAX_BRIDGE_MESSAGE_BYTES}-byte bridge ceiling — not captured`,
    );
    sendToDesktop({
      type: "capture-oversized",
      operation: message.operation,
      capturedAt,
      byteLength: framedBytes,
    });
    return;
  }
  if (!sendToDesktop(capture)) {
    console.error("[nmc] developer capture: native host unreachable — response not captured");
  }
}

async function handleCapture(message: WorkerCaptureMessage): Promise<void> {
  const settings: Settings | null = await loadSettings().catch(() => null);
  if (settings?.devCaptureEnabled) {
    forwardDevCapture(message);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.bodyText);
  } catch {
    return; // Not JSON (or truncated): nothing trustworthy to forward.
  }

  const posts = parseHomeTimeline(payload);
  if (posts.length === 0) return;
  const uniqueCount = await session.countPosts(posts);
  if (!settings?.devCaptureEnabled) await updateBadge(uniqueCount);

  const batch: PostBatch = {
    source: "x-home-timeline",
    capturedAt: new Date().toISOString(),
    posts,
  };
  sendToDesktop({ type: "post-batch", batch });
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isWorkerCaptureMessage(message)) return;
  const workerMessage: WorkerCaptureMessage = {
    kind: message.kind,
    operation: message.operation,
    bodyText: message.bodyText,
  };
  void handleCapture(workerMessage).catch((error: unknown) => {
    console.error(`[nmc] capture handling failed: ${String(error)}`);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[SETTINGS_STORAGE_KEY];
  if (areaName !== "local" || !change) return;
  const before = (change.oldValue as { devCaptureEnabled?: unknown } | undefined)
    ?.devCaptureEnabled;
  const after = (change.newValue as { devCaptureEnabled?: unknown } | undefined)
    ?.devCaptureEnabled;
  if (Boolean(before) === Boolean(after)) return;
  // One host process == one capture folder: closing the port ends it,
  // so the next capture starts a fresh host session too.
  port?.disconnect();
  port = null;
  void (async () => {
    await session.reset();
    await updateBadge(0);
  })().catch((error: unknown) => {
    console.error(`[nmc] capture session reset failed: ${String(error)}`);
  });
});

/** Mode B entry point — guarded off unless the user opted in. */
export async function maybeRunModeB(): Promise<"disabled" | "not-implemented"> {
  const settings = await loadSettings();
  if (!settings.modeBEnabled) return "disabled";
  // TODO(mode-b): hidden-tab auto-scroll. Ships separately, opt-in only;
  // see README "Mode B and its risks".
  return "not-implemented";
}
