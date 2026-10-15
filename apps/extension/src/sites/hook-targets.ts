/**
 * Which "more" patterns the hook on a page listens for: rules on this
 * page's host with a `request` pattern in HTML format, enabled and
 * permitted. Reads the raw stored objects without zod (content script);
 * the worker re-validates every capture against the parsed rule.
 */

export interface HookTarget {
  siteId: string;
  pattern: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function hookTargetsFor(rules: unknown, states: unknown, pageUrl: string): HookTarget[] {
  let host: string;
  try {
    host = new URL(pageUrl).host.toLowerCase();
  } catch {
    return [];
  }
  const allStates = record(states) ?? {};
  const targets: HookTarget[] = [];
  for (const [id, raw] of Object.entries(record(rules) ?? {})) {
    const rule = record(raw);
    const request = record(record(rule?.["collect"])?.["request"]);
    const pattern = request?.["match"];
    if (typeof pattern !== "string" || request?.["format"] !== "html") continue;
    if (pattern.split("/")[0]?.toLowerCase() !== host) continue;
    const state = record(allStates[id]);
    if (state?.["enabled"] === false || state?.["permissionGranted"] !== true) continue;
    targets.push({ siteId: id, pattern });
  }
  return targets;
}
