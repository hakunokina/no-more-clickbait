/**
 * Reddit developer capture (no parser yet — this only collects samples
 * so the feed's real shape can be learned). Reddit ships posts as
 * `<shreddit-post>` elements whose attributes carry the data: the first
 * page arrives in the document HTML, later pages as HTML fragments under
 * `/svc/shreddit/`. Which path the Home feed uses is not known yet, so
 * besides `/svc/shreddit/` (and Reddit's GraphQL hosts) any other
 * reddit.com text response that mentions `shreddit-post` is kept too.
 */

/** Element tags that hold one feed post (organic or ad). */
export const SHREDDIT_POST_SELECTOR = "shreddit-post, shreddit-ad-post";

/** The bridge's `operation` limit. */
const MAX_LABEL_LENGTH = 64;

export interface RedditResponseTarget {
  /** Path label for the dump file name and summary.json. */
  label: string;
  /** Kept whatever the body; otherwise only when it mentions `shreddit-post`. */
  always: boolean;
}

/**
 * Fixed route words kept in labels. Any other path segment may be a
 * subreddit, user, post slug or title, so it becomes `{x}`.
 */
const ROUTE_WORDS = new Set([
  "svc",
  "shreddit",
  "feeds",
  "feed",
  "r",
  "u",
  "user",
  "comments",
  "community-more-posts",
  "more-posts",
  "more-comments",
  "home-feed",
  "popular-feed",
  "partial",
  "graphql",
  "api",
  "home",
  "popular",
  "all",
  "best",
  "hot",
  "new",
  "top",
  "rising",
  "controversial",
]);

/** A segment right after these is a name, whatever it spells. */
const NAME_KINDS = new Set(["r", "u", "user"]);

/**
 * Keeps only a path's structure: summary.json is shared, so no
 * subreddit, user name or post title may reach a label. Names become
 * `{x}`, thing ids `{id}`, everything after `comments/<id>` `*`.
 */
export function normaliseRedditPath(pathname: string): string {
  const segments = pathname.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    const previous = (segments[i - 1] ?? "").toLowerCase();
    const word = segment.toLowerCase();
    if (segment === "") {
      out.push("");
    } else if (previous === "comments") {
      out.push("{id}");
      if (segments.slice(i + 1).some((rest) => rest !== "")) out.push("*");
      else if (segments.length > i + 1) out.push("");
      break;
    } else if (NAME_KINDS.has(previous)) {
      out.push("{x}");
    } else if (/^t[1-6]_[a-z0-9]+$/.test(word)) {
      out.push("{id}");
    } else {
      out.push(ROUTE_WORDS.has(word) ? word : "{x}");
    }
  }
  return out.join("/");
}

/** Query key names Reddit uses; any other key may itself be data. */
const QUERY_KEYS = new Set([
  "after",
  "before",
  "name",
  "sort",
  "t",
  "feedLength",
  "limit",
  "count",
  "cursor",
  "context",
  "q",
  "distance",
  "adDistance",
  "seeMoreHref",
  "sr_detail",
  "raw_json",
  "is_mobile",
]);

/** Query strings keep only their key names (`?after&name`), never values. */
export function normaliseRedditQuery(search: string): string {
  const keys = new Set(
    [...new URLSearchParams(search).keys()].map((key) => (QUERY_KEYS.has(key) ? key : "{x}")),
  );
  return keys.size > 0 ? `?${[...keys].join("&")}` : "";
}

/** Which page-made reddit.com responses developer capture keeps, and as what. */
export function redditResponseTarget(
  rawUrl: string,
  pageOrigin: string,
): RedditResponseTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, pageOrigin);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || !(host === "reddit.com" || host.endsWith(".reddit.com"))) {
    return null;
  }
  const path = normaliseRedditPath(url.pathname) + normaliseRedditQuery(url.search);
  const sameOrigin = url.origin === pageOrigin;
  const label = (sameOrigin ? path : `${host}${path}`).slice(0, MAX_LABEL_LENGTH);
  const always =
    (sameOrigin && url.pathname.startsWith("/svc/shreddit/")) || /^gql(-fed)?\./.test(host);
  return { label, always };
}

/** Only text bodies are read (HTML fragments, JSON). */
export function isTextContentType(contentType: string | null): boolean {
  return contentType !== null && /html|json|text\/plain/i.test(contentType);
}

export function keepRedditBody(target: RedditResponseTarget, bodyText: string): boolean {
  return target.always || bodyText.includes("shreddit-post");
}

function postsUnder(node: Node): Element[] {
  if (!(node instanceof Element)) return [];
  const found = node.matches(SHREDDIT_POST_SELECTOR) ? [node] : [];
  return found.concat([...node.querySelectorAll(SHREDDIT_POST_SELECTOR)]);
}

/**
 * Snapshots the document's post elements once the HTML is parsed
 * ("dom-initial"), then posts added later ("dom-added", batched) — the
 * safety net for posts that reach the page some other way than a
 * response the MAIN-world listener recognises. Each element is sent once.
 */
export class RedditDomCollector {
  readonly #doc: Document;
  readonly #send: (operation: string, bodyText: string) => void;
  readonly #flushDelayMs: number;
  #seen = new WeakSet<Element>();
  #pending: Element[] = [];
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(
    doc: Document,
    send: (operation: string, bodyText: string) => void,
    flushDelayMs = 1_000,
  ) {
    this.#doc = doc;
    this.#send = send;
    this.#flushDelayMs = flushDelayMs;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (this.#doc.readyState === "loading") {
      this.#doc.addEventListener("DOMContentLoaded", () => this.#begin(), { once: true });
    } else {
      this.#begin();
    }
  }

  stop(): void {
    this.#running = false;
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = [];
    // The next start is a new capture folder: it gets its own dom-initial.
    this.#seen = new WeakSet<Element>();
  }

  #begin(): void {
    if (!this.#running || this.#observer) return;
    const initial = this.#unseen(postsUnder(this.#doc.documentElement));
    if (initial.length > 0) this.#emit("dom-initial", initial);
    const view = this.#doc.defaultView;
    if (!view) return;
    this.#observer = new view.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          this.#pending.push(...this.#unseen(postsUnder(node)));
      }
      if (this.#pending.length > 0 && !this.#timer) {
        this.#timer = setTimeout(() => this.#flush(), this.#flushDelayMs);
      }
    });
    this.#observer.observe(this.#doc.documentElement, { childList: true, subtree: true });
  }

  #flush(): void {
    this.#timer = null;
    const added = this.#pending;
    this.#pending = [];
    if (this.#running && added.length > 0) this.#emit("dom-added", added);
  }

  #unseen(elements: Element[]): Element[] {
    return elements.filter((element) => {
      if (this.#seen.has(element)) return false;
      this.#seen.add(element);
      return true;
    });
  }

  #emit(operation: string, elements: Element[]): void {
    this.#send(operation, elements.map((element) => element.outerHTML).join("\n"));
  }
}
