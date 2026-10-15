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
  /** HTTP status of the response, when known (429 = rate limited). */
  status?: number;
}

/** Content script -> service worker, via chrome.runtime.sendMessage. */
export interface WorkerCaptureMessage {
  kind: "timeline-capture";
  operation: string;
  bodyText: string;
  status?: number;
}

/** Options/popup page -> service worker: start or stop a Mode B run. */
export interface ModeBCommandMessage {
  kind: "mode-b-command";
  command: "start" | "stop";
}

/** Service worker -> the Mode B tab content script: do one scroll step. */
export interface ModeBStepMessage {
  kind: "mode-b-step";
}

/** What the page looked like when a Mode B step ran. */
export type ModeBPageKind = "timeline" | "loading" | "login" | "error" | "away";

/** The content script answer to a ModeBStepMessage. */
export interface ModeBPageReport {
  kind: "mode-b-page";
  page: ModeBPageKind;
  /** `document.hidden` at the time of the step. */
  hidden: boolean;
  /** The scroll position actually changed. */
  scrolled: boolean;
}

function isOptionalStatus(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}

export function isTimelineCaptureMessage(value: unknown): value is TimelineCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "timeline-response" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string" &&
    isOptionalStatus(v["status"])
  );
}

export function isWorkerCaptureMessage(value: unknown): value is WorkerCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "timeline-capture" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string" &&
    isOptionalStatus(v["status"])
  );
}

export function isModeBCommandMessage(value: unknown): value is ModeBCommandMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "mode-b-command" && (v["command"] === "start" || v["command"] === "stop")
  );
}

export function isModeBStepMessage(value: unknown): value is ModeBStepMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["kind"] === "mode-b-step"
  );
}

const PAGE_KINDS: readonly string[] = ["timeline", "loading", "login", "error", "away"];

export function isModeBPageReport(value: unknown): value is ModeBPageReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "mode-b-page" &&
    typeof v["page"] === "string" &&
    PAGE_KINDS.includes(v["page"]) &&
    typeof v["hidden"] === "boolean" &&
    typeof v["scrolled"] === "boolean"
  );
}
