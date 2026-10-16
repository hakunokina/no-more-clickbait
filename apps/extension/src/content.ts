import { isTimelineCaptureMessage, type WorkerCaptureMessage } from "./messages.js";
import { answerModeBStep } from "./mode-b-page.js";

/**
 * Isolated-world bridge: relays MAIN-world captures to the service
 * worker. Only same-origin window messages with our marker are relayed;
 * payload bodies are treated as untrusted bytes downstream.
 */
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!isTimelineCaptureMessage(event.data)) return;

  const message: WorkerCaptureMessage = {
    kind: "timeline-capture",
    operation: event.data.operation,
    bodyText: event.data.bodyText,
    ...(event.data.status === undefined ? {} : { status: event.data.status }),
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
});

/** Mode B: the worker drives scrolling one step at a time (see mode-b-page.ts). */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const report = answerModeBStep(message, sender, chrome.runtime.id, document, window);
  if (report) sendResponse(report);
});
