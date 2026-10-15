import {
  hookPatternMatches,
  isSiteHookResponseMessage,
  PAGE_MESSAGE_SOURCE,
  type SiteHookArmMessage,
  type SiteRequestCaptureMessage,
} from "./sites/hook-protocol.js";
import { hookTargetsFor, type HookTarget } from "./sites/hook-targets.js";
import { SITE_RULES_KEY, SITE_STATES_KEY } from "./sites/storage-keys.js";

/**
 * Isolated-world side of the "more" capture (registered next to
 * site-hook.ts). Arms the hook with this site's `request` patterns from
 * storage, and passes each matching response to the worker, which
 * re-validates it and turns it into items with the rule (offscreen).
 */

let targets: HookTarget[] = [];

async function arm(): Promise<void> {
  const stored = await chrome.storage.local.get([SITE_RULES_KEY, SITE_STATES_KEY]);
  targets = hookTargetsFor(stored[SITE_RULES_KEY], stored[SITE_STATES_KEY], location.href);
  const message: SiteHookArmMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "site-hook-arm",
    patterns: targets.map((target) => target.pattern),
    detect: false,
  };
  window.postMessage(message, window.location.origin);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isSiteHookResponseMessage(event.data)) return;
  const { url, bodyText } = event.data;
  const target = targets.find((t) => hookPatternMatches(t.pattern, url));
  if (!target) return;
  const message: SiteRequestCaptureMessage = {
    kind: "site-request-capture",
    siteId: target.siteId,
    url,
    bodyText,
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
});

void arm().catch(() => undefined);
