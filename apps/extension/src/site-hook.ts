import {
  hookPatternMatches,
  isReadableContentType,
  isSiteHookArmMessage,
  MAX_HOOK_BODY_CHARS,
  PAGE_MESSAGE_SOURCE,
  type SiteHookResponseMessage,
} from "./sites/hook-protocol.js";

/**
 * MAIN-world hook for a custom site's own "more items" responses
 * (collect method `request`). Registered only for sites whose rule is
 * enabled, has a `request` pattern and whose permission is granted
 * (site-hooks.ts); the picker also injects it to detect the pattern.
 * The page's own responses are observed as it fetches them; NO request
 * is made and NO page behaviour changes. Bodies are read only once the
 * isolated side armed us, and only for matching same-origin responses.
 */

const INSTALLED = "__nmcSiteHook";
const scope = window as unknown as Record<string, boolean>;

let patterns: string[] = [];
let detect = false;

function wanted(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }
  if (parsed.origin !== window.location.origin) return false;
  return detect || patterns.some((pattern) => hookPatternMatches(pattern, parsed.href));
}

function forward(url: string, contentType: string, bodyText: string): void {
  if (bodyText.length > MAX_HOOK_BODY_CHARS) return;
  const message: SiteHookResponseMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "site-hook-response",
    url: new URL(url, window.location.href).href,
    contentType,
    bodyText,
  };
  window.postMessage(message, window.location.origin);
}

function patchFetch(): void {
  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): ReturnType<typeof fetch> {
    const response = await originalFetch.apply(this, args);
    try {
      const url =
        response.url ||
        (typeof args[0] === "string"
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String(args[0]));
      const contentType = response.headers.get("content-type");
      if (wanted(url) && isReadableContentType(contentType)) {
        // Clone so the page's own reader is never disturbed.
        void response
          .clone()
          .text()
          .then((bodyText) => forward(url, contentType ?? "", bodyText))
          .catch(() => undefined);
      }
    } catch {
      // Never let observation break the page's request.
    }
    return response;
  };
}

function patchXhr(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap<XMLHttpRequest, string>();

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    urls.set(this, typeof url === "string" ? url : url.toString());
    return originalOpen.call(this, method, url, async, username, password);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    ...args: Parameters<typeof originalSend>
  ): void {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || (urls.get(this) ?? "");
        const contentType = this.getResponseHeader("content-type");
        if (
          wanted(url) &&
          (this.responseType === "" || this.responseType === "text") &&
          isReadableContentType(contentType)
        ) {
          forward(url, contentType ?? "", this.responseText);
        }
      } catch {
        // Response not readable as text; nothing to forward.
      }
    });
    return originalSend.apply(this, args);
  };
}

if (!scope[INSTALLED]) {
  scope[INSTALLED] = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!isSiteHookArmMessage(event.data)) return;
    patterns = event.data.patterns;
    detect = event.data.detect;
  });
  patchFetch();
  patchXhr();
}
