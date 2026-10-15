import type { ModeBPageKind, ModeBPageReport } from "./messages.js";

/**
 * Mode B, page side: one scroll step in the run's x.com tab, driven by a
 * worker message — never by page timers, which Chromium throttles hard
 * in hidden tabs. The page's own requests (and the MAIN-world listener)
 * do the rest; this makes no requests itself.
 *
 * Page detection is heuristic (X ships no stable markers for these) and
 * only reads the DOM structure, never post text: a post that says
 * "Something went wrong" must not stop a run.
 */

/** What the classifier looks at; gathered from the DOM by `pageFacts`. */
export interface PageFacts {
  pathname: string;
  /** A login/sign-up control is on the page. */
  hasLoginControl: boolean;
  /** X's "Retry" button (its error / rate-limit state) is on the page. */
  hasRetryButton: boolean;
  /** Rendered timeline cells. */
  cellCount: number;
}

const LOGIN_PATH = /^\/(?:$|login\b|i\/flow\/(?:login|signup)\b)/;
const LOGIN_CONTROL = [
  '[data-testid="loginButton"]',
  '[data-testid="LoginForm_Login_Button"]',
  '[data-testid="google_sign_in_container"]',
].join(",");
const RETRY_LABELS = new Set(["retry", "tekrar dene"]);
const CELL = '[data-testid="cellInnerDiv"]';

export function classifyPage(facts: PageFacts): ModeBPageKind {
  if (LOGIN_PATH.test(facts.pathname) || facts.hasLoginControl) return "login";
  if (!facts.pathname.startsWith("/home")) return "away";
  if (facts.hasRetryButton) return "error";
  return facts.cellCount > 0 ? "timeline" : "loading";
}

export function pageFacts(doc: Document): PageFacts {
  const column = doc.querySelector('[data-testid="primaryColumn"]') ?? doc.body;
  const hasRetryButton = Array.from(
    column?.querySelectorAll('button, [role="button"]') ?? [],
  ).some((button) => RETRY_LABELS.has((button.textContent ?? "").trim().toLowerCase()));
  return {
    pathname: doc.location.pathname,
    hasLoginControl: doc.querySelector(LOGIN_CONTROL) !== null,
    hasRetryButton,
    cellCount: doc.querySelectorAll(CELL).length,
  };
}

function toBottom(doc: Document, win: Window): void {
  // We read X's network answers, not the DOM, so the posts skipped over
  // need not render; only the list's load-more sentinel at the bottom
  // has to come into view.
  win.scrollTo(0, (doc.scrollingElement ?? doc.documentElement).scrollHeight);
  const cells = doc.querySelectorAll(CELL);
  cells[cells.length - 1]?.scrollIntoView({ block: "end" });
  // Hidden documents skip rendering, so the browser may not fire the
  // scroll event the infinite list listens for; send one ourselves.
  win.dispatchEvent(new Event("scroll"));
}

/** One step: jump to the bottom of the timeline. Reports the page state. */
export function scrollStep(doc: Document, win: Window): ModeBPageReport {
  const page = classifyPage(pageFacts(doc));
  let scrolled = false;
  if (page === "timeline" || page === "loading") {
    const before = win.scrollY;
    toBottom(doc, win);
    scrolled = win.scrollY !== before;
  }
  return { kind: "mode-b-page", page, hidden: doc.hidden, scrolled };
}
