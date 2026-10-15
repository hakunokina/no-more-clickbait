import {
  isRedditResponseMessage,
  PAGE_MESSAGE_SOURCE,
  type RedditArmMessage,
  type WorkerRedditCaptureMessage,
} from "./messages.js";
import { RedditDomCollector } from "./reddit-page.js";
import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * Isolated-world side of Reddit developer capture. Runs only while
 * developer capture is on: arms the MAIN-world response listener,
 * relays what it forwards and adds DOM snapshots of the post elements
 * (the first page is in the document HTML, not in a response). The
 * worker checks the setting again before anything reaches the host.
 */

/** A raw read, not `loadSettings()`: its schema would put zod on every Reddit page. */
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
  const message: WorkerRedditCaptureMessage = { kind: "reddit-capture", operation, bodyText };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

const collector = new RedditDomCollector(document, send);
let enabled = false;

function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  const arm: RedditArmMessage = { source: PAGE_MESSAGE_SOURCE, kind: "reddit-arm", armed: on };
  window.postMessage(arm, window.location.origin);
  if (on) collector.start();
  else collector.stop();
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!enabled || event.source !== window || event.origin !== window.location.origin) return;
  if (isRedditResponseMessage(event.data)) send(event.data.label, event.data.bodyText);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_STORAGE_KEY]) {
    void devCaptureEnabled()
      .then(setEnabled)
      .catch(() => undefined);
  }
});

void devCaptureEnabled()
  .then(setEnabled)
  .catch(() => undefined);
