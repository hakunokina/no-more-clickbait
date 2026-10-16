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

/** Service worker -> the Mode B tab content script: jump to the bottom of the timeline. */
export interface ModeBStepMessage {
  kind: "mode-b-step";
  /**
   * The feed the run is scrolling (absent: X). A page of another site
   * answers "away": the run's tab is not where the run expects it.
   */
  source?: "instagram";
}

/** Popup -> service worker: end the user's own collection (Mode A) now, short of its targets. */
export interface CollectionFinishMessage {
  kind: "collection-finish";
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
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "mode-b-step" && (v["source"] === undefined || v["source"] === "instagram")
  );
}

export function isCollectionFinishMessage(value: unknown): value is CollectionFinishMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["kind"] === "collection-finish"
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

/**
 * Reddit developer capture. MAIN world -> isolated content script: one
 * reddit.com response the page itself fetched (`label` = its normalised
 * URL path), raw. The content script adds its own DOM snapshots.
 */
export interface RedditResponseMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "reddit-response";
  label: string;
  bodyText: string;
}

/** Isolated content script -> MAIN world: read response bodies only while armed. */
export interface RedditArmMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "reddit-arm";
  armed: boolean;
}

/** Content script -> service worker: one Reddit body for developer capture. */
export interface WorkerRedditCaptureMessage {
  kind: "reddit-capture";
  /** URL path label, or "dom-initial" / "dom-added" for DOM snapshots. */
  operation: string;
  bodyText: string;
}

export function isRedditResponseMessage(value: unknown): value is RedditResponseMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "reddit-response" &&
    typeof v["label"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

export function isRedditArmMessage(value: unknown): value is RedditArmMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "reddit-arm" &&
    typeof v["armed"] === "boolean"
  );
}

export function isWorkerRedditCaptureMessage(
  value: unknown,
): value is WorkerRedditCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "reddit-capture" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

/**
 * Instagram developer capture, the same three hops as Reddit's. MAIN
 * world -> isolated content script: one home-feed `/graphql/query`
 * response the page itself fetched, raw (`label` = transport only).
 */
export interface InstagramResponseMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "instagram-response";
  label: string;
  bodyText: string;
}

/** Isolated content script -> MAIN world: read response bodies only while armed. */
export interface InstagramArmMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "instagram-arm";
  armed: boolean;
}

/** Content script -> service worker: one Instagram body for developer capture. */
export interface WorkerInstagramCaptureMessage {
  kind: "instagram-capture";
  /** "ssr" (the document's embedded first page) or a "graphql-query:…" label. */
  operation: string;
  bodyText: string;
}

export function isInstagramResponseMessage(value: unknown): value is InstagramResponseMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "instagram-response" &&
    typeof v["label"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

export function isInstagramArmMessage(value: unknown): value is InstagramArmMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "instagram-arm" &&
    typeof v["armed"] === "boolean"
  );
}

export function isWorkerInstagramCaptureMessage(
  value: unknown,
): value is WorkerInstagramCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "instagram-capture" &&
    typeof v["operation"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}
