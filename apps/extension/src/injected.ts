import { PAGE_MESSAGE_SOURCE, type TimelineCaptureMessage } from "./messages.js";

/**
 * MAIN-world script. Mode A (passive collection): the page's own
 * HomeTimeline GraphQL responses are observed as X itself fetches them
 * while the user browses. We make NO extra requests, read NO cookies and
 * change NO page behaviour — responses are cloned and forwarded verbatim
 * to the isolated content script. Parsing happens later; this script is
 * deliberately dumb so there is little to break when X ships changes.
 */

const TIMELINE_OPERATION = /\/(HomeTimeline|HomeLatestTimeline)\b/;

function operationOf(url: string): string | null {
  const match = TIMELINE_OPERATION.exec(url);
  return match?.[1] ?? null;
}

function forward(operation: string, bodyText: string, status: number): void {
  const message: TimelineCaptureMessage = {
    source: PAGE_MESSAGE_SOURCE,
    kind: "timeline-response",
    operation,
    bodyText,
    status,
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
    const operation = operationOf(url) ?? operationOf(response.url);
    if (operation) {
      // Clone so the page's own reader is never disturbed.
      void response
        .clone()
        .text()
        .then((bodyText) => forward(operation, bodyText, response.status))
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
    const operation = operationOf(urls.get(this) ?? "");
    if (operation) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            forward(operation, this.responseText, this.status);
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
