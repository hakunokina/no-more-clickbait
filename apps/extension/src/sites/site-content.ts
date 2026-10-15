import { extractItems, type SiteRule } from "@nmc/core";

/**
 * Dynamically injected content script (ISOLATED world) for custom site
 * collection: answers extraction queries from the page step and drives
 * the rule's pagination inside the real page (site-page.ts). It never
 * runs on its own and makes no requests — whatever the page renders
 * came from the page's own flow.
 */

interface SiteExtractQuery {
  kind: "site-extract-query";
  rule: SiteRule;
}

interface SiteExtractAct {
  kind: "site-extract-act";
  action:
    | { type: "click"; selector: string }
    | { type: "scroll" }
    | { type: "next-page"; selector: string };
}

function isSiteExtractQuery(value: unknown): value is SiteExtractQuery {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "site-extract-query" && typeof v["rule"] === "object" && v["rule"] !== null
  );
}

function isSiteExtractAct(value: unknown): value is SiteExtractAct {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["kind"] !== "site-extract-act") return false;
  const action = v["action"];
  if (typeof action !== "object" || action === null) return false;
  const a = action as Record<string, unknown>;
  return (
    (a["type"] === "click" && typeof a["selector"] === "string") ||
    a["type"] === "scroll" ||
    (a["type"] === "next-page" && typeof a["selector"] === "string")
  );
}

/** Injected again after each "next page" navigation; never listen twice in one document. */
const LISTENING = "__nmcSiteContent";
const scope = globalThis as unknown as Record<string, boolean>;

if (!scope[LISTENING]) {
  scope[LISTENING] = true;
  chrome.runtime.onMessage.addListener(onMessage);
}

function onMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): void {
  if (sender.id !== chrome.runtime.id) return;
  if (isSiteExtractQuery(message)) {
    // The rule is validated data (core schema) and the engine only reads.
    const { items, stats } = extractItems(document, message.rule, { pageUrl: location.href });
    sendResponse({ items, stats, hidden: document.hidden });
    return;
  }
  if (isSiteExtractAct(message)) {
    const { action } = message;
    try {
      if (action.type === "scroll") {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        sendResponse({ drove: true });
        return;
      }
      const target = document.querySelector(action.selector);
      if (!target) {
        sendResponse({ drove: false });
        return;
      }
      if (action.type === "click") {
        (target as HTMLElement).click();
        sendResponse({ drove: true });
        return;
      }
      // next-page: a link — let the page navigate on its own.
      const href = target.getAttribute("href");
      if (href) {
        window.location.assign(new URL(href, location.href).href);
        sendResponse({ drove: true });
        return;
      }
      sendResponse({ drove: false });
    } catch {
      sendResponse({ drove: false });
    }
  }
}
