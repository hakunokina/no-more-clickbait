/** Message shapes used inside the extension (page <-> content <-> worker). */

export const PAGE_MESSAGE_SOURCE = "no-more-clickbait/page";

/** MAIN-world script -> isolated content script, via window.postMessage. */
export interface TimelineCaptureMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "timeline-response";
  /** Which GraphQL operation produced it, e.g. "HomeTimeline". */
  operation: string;
  /** Raw response body text. Untrusted: parsed later, in the worker. */
  bodyText: string;
}

/** Content script -> service worker, via chrome.runtime.sendMessage. */
export interface WorkerCaptureMessage {
  kind: "timeline-capture";
  operation: string;
  bodyText: string;
}

export function isTimelineCaptureMessage(value: unknown): value is TimelineCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "timeline-response" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

export function isWorkerCaptureMessage(value: unknown): value is WorkerCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "timeline-capture" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}
