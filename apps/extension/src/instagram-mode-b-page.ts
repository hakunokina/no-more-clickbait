import type { ModeBPageKind, ModeBPageReport, ModeBStepMessage } from "./messages.js";

/**
 * Mode B, Instagram page side: one scroll step in the run's tab once
 * the run has moved on to Instagram, driven by a worker message like
 * X's (mode-b-page.ts). The page's own feed requests (and the MAIN-world
 * listener) do the rest; this makes no requests itself.
 *
 * Page detection reads the DOM structure only, never post text.
 * Instagram shows no stable error page for a feed that stops loading;
 * such a run ends as "stalled", like an X feed that stops giving posts.
 */

export interface InstagramPageFacts {
  pathname: string;
  /** A login form is on the page (Instagram shows one at "/" when logged out). */
  hasLoginForm: boolean;
  /** Rendered feed posts. */
  postCount: number;
}

const LOGIN_PATH = /^\/accounts\/(?:login|emailsignup)\b/;
const LOGIN_FORM = ["form#loginForm", 'input[name="password"]'].join(",");
const POST = "main article";

export function classifyInstagramPage(facts: InstagramPageFacts): ModeBPageKind {
  if (LOGIN_PATH.test(facts.pathname) || facts.hasLoginForm) return "login";
  if (facts.pathname !== "/") return "away";
  return facts.postCount > 0 ? "timeline" : "loading";
}

export function instagramPageFacts(doc: Document): InstagramPageFacts {
  return {
    pathname: doc.location.pathname,
    hasLoginForm: doc.querySelector(LOGIN_FORM) !== null,
    postCount: doc.querySelectorAll(POST).length,
  };
}

function toBottom(doc: Document, win: Window): void {
  // As on X: the feed's answers are read from the network, so only the
  // list's load-more point at the bottom has to come into view.
  win.scrollTo(0, (doc.scrollingElement ?? doc.documentElement).scrollHeight);
  const posts = doc.querySelectorAll(POST);
  posts[posts.length - 1]?.scrollIntoView({ block: "end" });
  win.dispatchEvent(new Event("scroll"));
}

/**
 * One step: jump to the bottom of the feed. A step meant for another
 * site's feed (an X leg in a tab that is on Instagram) answers "away".
 */
export function instagramScrollStep(
  doc: Document,
  win: Window,
  message: ModeBStepMessage,
): ModeBPageReport {
  const page =
    message.source === "instagram" ? classifyInstagramPage(instagramPageFacts(doc)) : "away";
  let scrolled = false;
  if (page === "timeline" || page === "loading") {
    const before = win.scrollY;
    toBottom(doc, win);
    scrolled = win.scrollY !== before;
  }
  return { kind: "mode-b-page", page, hidden: doc.hidden, scrolled };
}
