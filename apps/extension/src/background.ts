import type { BridgeMessage, BridgeReply, PostBatch } from "@nmc/core";
import { isWorkerCaptureMessage } from "./messages.js";
import { parseHomeTimeline } from "./parse-home-timeline.js";
import { loadSettings } from "./settings.js";

/**
 * Service worker: receives captured timeline responses, converts them
 * to Post batches and hands them to the desktop app through Native
 * Messaging (no TCP port; the browser launches the host process).
 *
 * Mode B (auto-scroll a hidden tab until enough posts are gathered) is
 * intentionally only a guarded switch in this skeleton: it stays OFF
 * unless the user opts in on the options page, and the scrolling
 * implementation lands separately with its risks documented.
 */

export const NATIVE_HOST_NAME = "io.github.hakunokina.no_more_clickbait";

let port: chrome.runtime.Port | null = null;
let capturedCount = 0;

function nativePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.onMessage.addListener((_reply: BridgeReply) => {
    // Replies are surfaced in the popup in a later change.
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

async function updateBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: capturedCount === 0 ? "" : String(capturedCount) });
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isWorkerCaptureMessage(message)) return;

  let payload: unknown;
  try {
    payload = JSON.parse(message.bodyText);
  } catch {
    return; // Not JSON (or truncated): nothing trustworthy to forward.
  }

  const posts = parseHomeTimeline(payload);
  capturedCount += posts.length;
  void updateBadge();
  if (posts.length === 0) return;

  const batch: PostBatch = {
    source: "x-home-timeline",
    capturedAt: new Date().toISOString(),
    posts,
  };
  sendToDesktop({ type: "post-batch", batch });
});

/** Mode B entry point — guarded off unless the user opted in. */
export async function maybeRunModeB(): Promise<"disabled" | "not-implemented"> {
  const settings = await loadSettings();
  if (!settings.modeBEnabled) return "disabled";
  // TODO(mode-b): hidden-tab auto-scroll. Ships separately, opt-in only;
  // see README "Mode B and its risks".
  return "not-implemented";
}
