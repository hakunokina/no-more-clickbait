import {
  isRedditArmMessage,
  PAGE_MESSAGE_SOURCE,
  type RedditResponseMessage,
} from "./messages.js";
import {
  isTextContentType,
  keepRedditBody,
  redditResponseTarget,
  type RedditResponseTarget,
} from "./reddit-page.js";

/**
 * MAIN-world script on www.reddit.com, for developer capture only. The
 * page's own responses are observed as Reddit fetches them; we make NO
 * extra requests and change NO page behaviour. Bodies are read only
 * while the isolated content script has armed us (developer capture on)
 * and forwarded raw — which ones, see reddit-page.ts.
 */

let armed = false;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (isRedditArmMessage(event.data)) armed = event.data.armed;
});

function forward(target: RedditResponseTarget, bodyText: string): void {
  if (!keepRedditBody(target, bodyText)) return;
  const message: RedditResponseMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "reddit-response",
    label: target.label,
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
    if (!armed) return response;
    const url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof Request
          ? args[0].url
          : response.url;
    const target = redditResponseTarget(response.url || url, window.location.origin);
    if (target && isTextContentType(response.headers.get("content-type"))) {
      // Clone so the page's own reader is never disturbed.
      void response
        .clone()
        .text()
        .then((bodyText) => forward(target, bodyText))
        .catch(() => undefined);
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
    if (armed) {
      this.addEventListener("load", () => {
        try {
          const target = redditResponseTarget(
            this.responseURL || (urls.get(this) ?? ""),
            window.location.origin,
          );
          if (
            target &&
            (this.responseType === "" || this.responseType === "text") &&
            isTextContentType(this.getResponseHeader("content-type"))
          ) {
            forward(target, this.responseText);
          }
        } catch {
          // Response not readable as text; nothing to forward.
        }
      });
    }
    return originalSend.apply(this, args);
  };
}

patchFetch();
patchXhr();
