import { isTimelineCaptureMessage, type WorkerCaptureMessage } from "./messages.js";

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
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
});
