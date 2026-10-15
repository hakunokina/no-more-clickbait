import { PAGE_MESSAGE_SOURCE } from "../messages.js";

/**
 * Messages between the MAIN-world response hook (site-hook.ts), the
 * isolated scripts (site-relay.ts, the picker) and the worker. Kept free
 * of zod/core: the hook runs on every page of a site the user enabled
 * "more" capture for, and must stay small.
 */

export { PAGE_MESSAGE_SOURCE };

/** Isolated → MAIN: which responses to read. `detect`: report every same-origin text response. */
export interface SiteHookArmMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "site-hook-arm";
  patterns: string[];
  detect: boolean;
}

/** MAIN → isolated: one response the page itself fetched. */
export interface SiteHookResponseMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "site-hook-response";
  url: string;
  contentType: string;
  bodyText: string;
}

/** Relay → worker: a captured "more" response for one site rule. */
export interface SiteRequestCaptureMessage {
  kind: "site-request-capture";
  siteId: string;
  url: string;
  bodyText: string;
}

/** Bodies larger than this are not read (a "more" page is far smaller). */
export const MAX_HOOK_BODY_CHARS = 2_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function isSiteHookArmMessage(value: unknown): value is SiteHookArmMessage {
  const v = record(value);
  return (
    v?.["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "site-hook-arm" &&
    Array.isArray(v["patterns"]) &&
    v["patterns"].every((p) => typeof p === "string") &&
    typeof v["detect"] === "boolean"
  );
}

export function isSiteHookResponseMessage(value: unknown): value is SiteHookResponseMessage {
  const v = record(value);
  return (
    v?.["source"] === PAGE_MESSAGE_SOURCE &&
    v["kind"] === "site-hook-response" &&
    typeof v["url"] === "string" &&
    typeof v["contentType"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

export function isSiteRequestCaptureMessage(
  value: unknown,
): value is SiteRequestCaptureMessage {
  const v = record(value);
  return (
    v?.["kind"] === "site-request-capture" &&
    typeof v["siteId"] === "string" &&
    typeof v["url"] === "string" &&
    typeof v["bodyText"] === "string"
  );
}

/**
 * Same test as core's `urlMatchesPattern` ("host/path", "host/path/*",
 * "host/*"), repeated here so the page hook does not pull in zod. The
 * worker re-checks every capture with core's version.
 */
export function hookPatternMatches(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const slash = pattern.indexOf("/");
  const host = (slash < 0 ? pattern : pattern.slice(0, slash)).toLowerCase();
  if (host !== parsed.host.toLowerCase()) return false;
  const trim = (path: string): string => path.replace(/\/+$/, "") || "/";
  const rawPath = slash < 0 ? "/" : pattern.slice(slash);
  const path = trim(parsed.pathname);
  if (rawPath.endsWith("/*")) {
    const prefix = trim(rawPath.slice(0, -2));
    return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === trim(rawPath);
}

/** HTML, JSON or plain text: what a "more" response can be. */
export function isReadableContentType(contentType: string | null): boolean {
  const type = (contentType ?? "").toLowerCase();
  return /text\/html|application\/(?:[\w.+-]*\+)?json|text\/plain|application\/xhtml/.test(
    type,
  );
}
