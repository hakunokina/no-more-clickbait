import { extractItems, SiteRuleSchema } from "@nmc/core";

/**
 * Offscreen document: the extension's DOM host for static collection
 * (MV3 service workers have no `DOMParser`). The worker hands it the
 * fetched HTML + the rule; the same core engine that served the
 * picker's preview runs here, so what was previewed is what gets
 * collected. Nothing is rendered and no script in the HTML ever runs —
 * `text/html` parsing inertly builds a tree.
 */

interface OffscreenExtractQuery {
  kind: "offscreen-extract";
  html: string;
  pageUrl: string;
  rule: unknown;
}

function isOffscreenExtractQuery(value: unknown): value is OffscreenExtractQuery {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "offscreen-extract" &&
    typeof v["html"] === "string" &&
    typeof v["pageUrl"] === "string" &&
    typeof v["rule"] === "object" &&
    v["rule"] !== null
  );
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenExtractQuery(message)) return;
  const rule = SiteRuleSchema.safeParse(message.rule);
  if (!rule.success) {
    sendResponse({ ok: false, message: "invalid rule" });
    return;
  }
  try {
    const doc = new DOMParser().parseFromString(message.html, "text/html");
    const { items, stats } = extractItems(doc as unknown as Document, rule.data, {
      pageUrl: message.pageUrl,
    });
    sendResponse({ ok: true, items, stats });
  } catch (error) {
    sendResponse({ ok: false, message: String(error) });
  }
});
