import {
  isInstagramResponseMessage,
  PAGE_MESSAGE_SOURCE,
  type InstagramArmMessage,
  type WorkerInstagramCaptureMessage,
} from "./messages.js";
import { answerInstagramModeBStep } from "./instagram-mode-b-page.js";
import { InstagramSsrCollector } from "./instagram-page.js";
import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * Isolated-world side of the Instagram feed. Runs while Instagram is a
 * collection source or developer capture is on: arms the MAIN-world
 * response listener, relays what it forwards and adds the document's
 * embedded first feed page (no response carries it). The worker checks
 * the settings again before anything reaches the host. It also carries
 * out a Mode B run's scroll steps once the run is on Instagram.
 */

/** A raw read, not `loadSettings()`: its schema would put zod on every Instagram page. */
async function feedWanted(): Promise<boolean> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings: unknown = stored[SETTINGS_STORAGE_KEY];
  if (typeof settings !== "object" || settings === null) return false;
  const flags = settings as Record<string, unknown>;
  return flags["collectFromInstagram"] === true || flags["devCaptureEnabled"] === true;
}

function send(operation: string, bodyText: string): void {
  const message: WorkerInstagramCaptureMessage = {
    kind: "instagram-capture",
    operation,
    bodyText,
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

const collector = new InstagramSsrCollector(document, send);
collector.watch();
let enabled = false;

function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  const arm: InstagramArmMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "instagram-arm",
    armed: on,
  };
  window.postMessage(arm, window.location.origin);
  if (on) collector.start();
  else collector.stop();
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!enabled || event.source !== window || event.origin !== window.location.origin) return;
  if (isInstagramResponseMessage(event.data)) send(event.data.label, event.data.bodyText);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_STORAGE_KEY]) {
    void feedWanted()
      .then(setEnabled)
      .catch(() => undefined);
  }
});

/** Mode B: the worker drives scrolling one step at a time (see instagram-mode-b-page.ts). */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const report = answerInstagramModeBStep(message, sender, chrome.runtime.id, document, window);
  if (report) sendResponse(report);
});

void feedWanted()
  .then(setEnabled)
  .catch(() => undefined);
