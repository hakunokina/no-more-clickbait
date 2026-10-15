import {
  isInstagramArmMessage,
  PAGE_MESSAGE_SOURCE,
  type InstagramResponseMessage,
} from "./messages.js";
import { hasFeedRoot, isInstagramFeedQueryUrl, isInstagramHomePath } from "./instagram-page.js";

/**
 * MAIN-world script on www.instagram.com, for developer capture only.
 * The page's own `/graphql/query` responses are observed as Instagram
 * fetches them; we make NO extra requests and change NO page behaviour.
 * Bodies are read only while the isolated content script has armed us
 * (developer capture on), only on the home page, and forwarded raw when
 * they carry the feed root — which ones, see instagram-page.ts. The
 * label names the transport, so a dump shows how the page loads it.
 */

let armed = false;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (isInstagramArmMessage(event.data)) armed = event.data.armed;
});

function wanted(url: string): boolean {
  return (
    armed &&
    isInstagramHomePath(window.location.pathname) &&
    isInstagramFeedQueryUrl(url, window.location.origin)
  );
}

function forward(label: string, bodyText: string): void {
  if (!hasFeedRoot(bodyText)) return;
  const message: InstagramResponseMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "instagram-response",
    label,
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
    const url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof Request
          ? args[0].url
          : response.url;
    if (wanted(response.url || url)) {
      // Clone so the page's own reader is never disturbed.
      void response
        .clone()
        .text()
        .then((bodyText) => forward("graphql-query:fetch", bodyText))
        .catch(() => undefined);
    }
    return response;
  };
}

/** The body as text for the response types Instagram may pick (not verified yet). */
function xhrBody(xhr: XMLHttpRequest): { label: string; text: string } | null {
  switch (xhr.responseType) {
    case "":
    case "text":
      return { label: "graphql-query:xhr-text", text: xhr.responseText };
    case "json":
      return xhr.response === null
        ? null
        : { label: "graphql-query:xhr-json", text: JSON.stringify(xhr.response) };
    case "arraybuffer":
      return xhr.response instanceof ArrayBuffer
        ? {
            label: "graphql-query:xhr-arraybuffer",
            text: new TextDecoder().decode(xhr.response),
          }
        : null;
    default:
      return null;
  }
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
          if (!wanted(this.responseURL || (urls.get(this) ?? ""))) return;
          const body = xhrBody(this);
          if (body) forward(body.label, body.text);
        } catch {
          // Response not readable; nothing to forward.
        }
      });
    }
    return originalSend.apply(this, args);
  };
}

patchFetch();
patchXhr();
