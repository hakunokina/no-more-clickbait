/**
 * The slice of the DOM the rule engine and the selector helpers use.
 *
 * Core compiles without the DOM lib (it also runs in Node: desktop,
 * native host), so these are structural types: a browser `Document`/
 * `Element` (live tab, offscreen `DOMParser`) and happy-dom/jsdom
 * objects (tests) all fit them as they are. Nothing here touches a DOM
 * global; the caller hands the root in.
 */

export interface DomNode {
  /** 1 element, 3 text, 4 CDATA, 8 comment, 9 document. */
  readonly nodeType: number;
  readonly nodeValue: string | null;
}

export interface DomQueryRoot {
  querySelector(selectors: string): DomElement | null;
  querySelectorAll(selectors: string): ArrayLike<DomElement>;
}

export interface DomElement extends DomNode, DomQueryRoot {
  readonly tagName: string;
  readonly parentElement: DomElement | null;
  readonly children: ArrayLike<DomElement>;
  readonly childNodes: ArrayLike<DomNode>;
  readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>;
  getAttribute(name: string): string | null;
  matches(selectors: string): boolean;
}

export const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** Upper bounds of one extracted field, in characters. */
export const MAX_TITLE_CHARS = 500;
export const MAX_TEXT_CHARS = 4000;
export const MAX_AUTHOR_CHARS = 200;

/** One line, whitespace (NBSP too) collapsed, capped with an ellipsis. */
export function normalizeText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** Not read: code, invisible and decorative content. */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME"]);

/** Tags whose text is a separate word from its neighbours' (`<p>a</p><p>b</p>` → "a b"). */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

/**
 * The visible text of `element`, read without touching the page: the
 * elements in `skip` (the rule's "remove from text" matches), hidden
 * ones and code are left out. Not normalized.
 */
export function visibleText(element: DomElement, skip: ReadonlySet<DomElement>): string {
  const parts: string[] = [];
  const walk = (node: DomElement): void => {
    const nodes = node.childNodes;
    for (let i = 0; i < nodes.length; i += 1) {
      const child = nodes[i];
      if (!child) continue;
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
        parts.push(child.nodeValue ?? "");
      } else if (child.nodeType === ELEMENT_NODE) {
        const el = child as unknown as DomElement;
        if (skip.has(el) || isHidden(el)) continue;
        const block = BLOCK_TAGS.has(el.tagName.toUpperCase());
        if (block) parts.push(" ");
        walk(el);
        if (block) parts.push(" ");
      }
    }
  };
  if (!isHidden(element)) walk(element);
  return parts.join("");
}

function isHidden(el: DomElement): boolean {
  return (
    SKIPPED_TAGS.has(el.tagName.toUpperCase()) ||
    el.getAttribute("hidden") !== null ||
    el.getAttribute("aria-hidden") === "true"
  );
}

/** `raw` resolved against `base` when it is an http(s) URL, else undefined. */
export function resolveHttpUrl(
  raw: string | null | undefined,
  base: string,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page's base URL: `<base href>` (resolved against `pageUrl`) when
 * the root has one, else `pageUrl`. Never `document.baseURI`: a page
 * parsed in an offscreen document reports the extension's own URL there.
 */
export function documentBase(root: DomQueryRoot, pageUrl: string): string {
  let base: DomElement | null = null;
  try {
    base = root.querySelector("base[href]");
  } catch {
    // A root that cannot run selectors has no <base> for us either.
  }
  return resolveHttpUrl(base?.getAttribute("href"), pageUrl) ?? pageUrl;
}

/** querySelectorAll as an array; an invalid selector yields an error, not a throw. */
export function selectAll(
  root: DomQueryRoot,
  selector: string,
): { ok: true; elements: DomElement[] } | { ok: false } {
  try {
    return { ok: true, elements: Array.from(root.querySelectorAll(selector)) };
  } catch {
    return { ok: false };
  }
}
