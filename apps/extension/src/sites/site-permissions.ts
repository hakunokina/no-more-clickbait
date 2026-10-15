import type { SiteRule } from "@nmc/core";

/**
 * Per-site host permissions. No `<all_urls>`: every rule brings its own
 * origin (plus the feed's, when the feed lives on another host), asked
 * inside the user's click (`permissions.request` needs a user gesture).
 * Manifest: `optional_host_permissions: ["https://*\/*", "http://*\/*"]`.
 */

/** The `chrome.permissions` surface used here (fakeable in tests). */
export interface PermissionsApi {
  contains(request: { origins: string[] }): Promise<boolean>;
  request(request: { origins: string[] }): Promise<boolean>;
  remove(request: { origins: string[] }): Promise<boolean>;
}

/** "https://news.example/*" for an address; undefined for non-http(s). Match patterns carry no port. */
export function originPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}/*`;
  } catch {
    return undefined;
  }
}

/** The page's origin, plus the feed's when it differs. */
export function siteOrigins(rule: Pick<SiteRule, "url" | "collect">): string[] {
  const origins = new Set<string>();
  for (const url of [rule.url, rule.collect.rssUrl]) {
    const origin = url ? originPattern(url) : undefined;
    if (origin) origins.add(origin);
  }
  return [...origins];
}

/** True when every origin of the rule is granted. */
export async function hasSitePermission(
  api: Pick<PermissionsApi, "contains">,
  rule: Pick<SiteRule, "url" | "collect">,
): Promise<boolean> {
  const origins = siteOrigins(rule);
  if (origins.length === 0) return false;
  try {
    return await api.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Asks for the origins. Call it synchronously from the click handler
 * (before any await), or the browser refuses for lack of a user gesture.
 * Resolves false when refused or when the browser throws.
 */
export function requestOrigins(
  api: Pick<PermissionsApi, "request">,
  origins: string[],
): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(false);
  return api.request({ origins }).catch(() => false);
}

/**
 * Origins no remaining rule needs, so deleting a rule can give its
 * permission back without taking one another rule still uses.
 */
export function unusedOrigins(
  removed: Pick<SiteRule, "url" | "collect">,
  remaining: ReadonlyArray<Pick<SiteRule, "url" | "collect">>,
): string[] {
  const kept = new Set(remaining.flatMap((rule) => siteOrigins(rule)));
  return siteOrigins(removed).filter((origin) => !kept.has(origin));
}

/** Rules hit by a permission the user revoked in the browser (`permissions.onRemoved`). */
export function rulesAffectedBy<R extends Pick<SiteRule, "id" | "url" | "collect">>(
  rules: readonly R[],
  removedOrigins: readonly string[],
): R[] {
  const removed = new Set(removedOrigins.map((origin) => origin.toLowerCase()));
  return rules.filter((rule) => siteOrigins(rule).some((origin) => removed.has(origin)));
}
