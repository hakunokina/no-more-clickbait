/**
 * Instagram developer capture: which bodies are the home feed. The
 * first page is embedded in the document (`<script type="application/
 * json">`, a Relay prefetch blob), later pages arrive as responses to
 * `POST /graphql/query`. Both carry the feed under one root key; the
 * query's doc_id rotates within days, so it is never matched on. Only
 * the home page ("/") counts: Instagram also preloads the feed behind
 * other views. Parsing is core's job (`parseInstagramTimeline`, run by
 * the host); this module only picks bodies, without importing core
 * (its zod would land on every Instagram page).
 */

/** Same as core's `INSTAGRAM_FEED_ROOT_KEY`. */
export const INSTAGRAM_FEED_ROOT_KEY = "xdt_api__v1__feed__timeline__connection";

/** The root key with an object value (a `null` root is the wrong-endpoint answer). */
const NON_NULL_ROOT = new RegExp(`"${INSTAGRAM_FEED_ROOT_KEY}"\\s*:\\s*\\{`);

export const INSTAGRAM_ORIGIN = "https://www.instagram.com";

export function isInstagramHomePath(pathname: string): boolean {
  return pathname === "/";
}

/** A request the page made to its own GraphQL endpoint. */
export function isInstagramFeedQueryUrl(rawUrl: string, pageOrigin: string): boolean {
  try {
    const url = new URL(rawUrl, pageOrigin);
    return (
      url.origin === INSTAGRAM_ORIGIN &&
      (url.pathname === "/graphql/query" || url.pathname === "/graphql/query/")
    );
  } catch {
    return false;
  }
}

/** A response body that carries a non-null feed connection (any `for (;;);` prefix is fine). */
export function hasFeedRoot(bodyText: string): boolean {
  return NON_NULL_ROOT.test(bodyText);
}

/** Deep enough for the Relay prefetch blob; guards against pathological input. */
const MAX_SEARCH_DEPTH = 64;

/** True when the parsed value holds a non-null feed connection at any depth. */
export function containsFeedConnection(value: unknown, depth = 0): boolean {
  if (depth > MAX_SEARCH_DEPTH || typeof value !== "object" || value === null) return false;
  if (Array.isArray(value))
    return value.some((child) => containsFeedConnection(child, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === INSTAGRAM_FEED_ROOT_KEY) {
      if (typeof child === "object" && child !== null && !Array.isArray(child)) return true;
    } else if (containsFeedConnection(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** An embedded JSON block's text, when it holds the feed (parsed, not just mentioned). */
export function feedBlockText(script: Element): string | null {
  const text = script.textContent ?? "";
  if (!text.includes(INSTAGRAM_FEED_ROOT_KEY)) return null;
  try {
    return containsFeedConnection(JSON.parse(text)) ? text : null;
  } catch {
    return null;
  }
}

const JSON_SCRIPT_SELECTOR = 'script[type="application/json"]';

/**
 * Sends the document's embedded first feed page ("ssr"). The script
 * elements are picked once the HTML is parsed — on the home page only,
 * whether or not capture is on yet, so a page that drops them later
 * cannot hide them — and sent while capture runs, each once per run.
 */
export class InstagramSsrCollector {
  readonly #doc: Document;
  readonly #send: (operation: string, bodyText: string) => void;
  #blocks: Element[] | null = null;
  #sent = new WeakSet<Element>();
  #running = false;

  constructor(doc: Document, send: (operation: string, bodyText: string) => void) {
    this.#doc = doc;
    this.#send = send;
  }

  /** Call once at script start. */
  watch(): void {
    if (this.#doc.readyState === "loading") {
      this.#doc.addEventListener("DOMContentLoaded", () => this.#snapshot(), { once: true });
    } else {
      this.#snapshot();
    }
  }

  start(): void {
    this.#running = true;
    this.#flush();
  }

  stop(): void {
    this.#running = false;
    // The next start is a new capture folder: it gets the first page again.
    this.#sent = new WeakSet<Element>();
  }

  #snapshot(): void {
    const home = isInstagramHomePath(this.#doc.defaultView?.location.pathname ?? "");
    this.#blocks = home ? [...this.#doc.querySelectorAll(JSON_SCRIPT_SELECTOR)] : [];
    this.#flush();
  }

  #flush(): void {
    if (!this.#running || !this.#blocks) return;
    for (const script of this.#blocks) {
      if (this.#sent.has(script)) continue;
      this.#sent.add(script);
      const text = feedBlockText(script);
      if (text !== null) this.#send("ssr", text);
    }
  }
}
