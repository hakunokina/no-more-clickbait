import {
  isInstagramResponseMessage,
  PAGE_MESSAGE_SOURCE,
  type InstagramArmMessage,
  type WorkerInstagramCaptureMessage,
} from "./messages.js";
import { InstagramSsrCollector } from "./instagram-page.js";
import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * Isolated-world side of Instagram developer capture. Runs only while
 * developer capture is on: arms the MAIN-world response listener,
 * relays what it forwards and adds the document's embedded first feed
 * page (no response carries it). The worker checks the setting again
 * before anything reaches the host.
 */

/** A raw read, not `loadSettings()`: its schema would put zod on every Instagram page. */
async function devCaptureEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings: unknown = stored[SETTINGS_STORAGE_KEY];
  return (
    typeof settings === "object" &&
    settings !== null &&
    (settings as Record<string, unknown>)["devCaptureEnabled"] === true
  );
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
    void devCaptureEnabled().then(setEnabled);
  }
});

void devCaptureEnabled()
  .then(setEnabled)
  .catch(() => undefined);
