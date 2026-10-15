import { selectAll, type DomElement, type DomQueryRoot } from "./dom.js";

/**
 * Selector writing for the picker (pure functions over the DOM; design:
 * rule-picker.md "Seçici üretimi"). What makes a selector survive the
 * site's next deploy, best first: a test id (`data-testid` …), a
 * semantic attribute (`itemprop`, `role`), a meaningful class, the tag.
 * Generated class names (CSS-in-JS, CSS modules) are never used, and
 * `:nth-of-type` only as the last resort.
 */

/** A plain CSS identifier: usable after "." with no escaping. */
const SAFE_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
const SEMANTIC_ATTRS = ["itemprop", "role"];
/** Classes that come and go with state ("is-active", "selected"). */
const STATE_CLASS =
  /^(?:is-|has-)|^(?:active|current|selected|open|hover|focus|visible|hidden)$/i;

/**
 * True for a class worth writing into a rule: a plain identifier that
 * does not look generated ("css-1x2y3", "sc-abc", "_a1B2c",
 * "Card_title__3xYz9") and is not a state class.
 */
export function isStableClass(name: string): boolean {
  if (!SAFE_IDENT.test(name) || STATE_CLASS.test(name)) return false;
  if (/^(?:css|sc|jsx|emotion|styled|svelte)-/i.test(name)) return false;
  if (name.startsWith("_") && /\d/.test(name)) return false;
  return !looksGenerated(name);
}

/** A 5+ character segment mixing letters and digits reads as a hash. */
function looksGenerated(value: string): boolean {
  return value
    .split(/[-_]+/)
    .some((part) => part.length >= 5 && /\d/.test(part) && /[a-z]/i.test(part));
}

function isStableValue(value: string): boolean {
  return value.length <= 40 && /^[A-Za-z][\w-]*$/.test(value) && !looksGenerated(value);
}

function tagOf(el: DomElement): string {
  const tag = el.tagName.toLowerCase();
  return SAFE_IDENT.test(tag) ? tag : "*";
}

/** The element's stable simple selectors (no tag), most stable first. */
function featuresOf(el: DomElement): string[] {
  const features: string[] = [];
  for (const name of [...TEST_ATTRS, ...SEMANTIC_ATTRS]) {
    const value = el.getAttribute(name);
    if (value !== null && isStableValue(value)) features.push(`[${name}="${value}"]`);
  }
  const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(isStableClass);
  // BEM modifiers ("card--featured") narrow; the block class generalizes.
  classes.sort((a, b) => Number(a.includes("--")) - Number(b.includes("--")));
  for (const name of classes) features.push(`.${name}`);
  return features;
}

/**
 * The clicked element's own selector, e.g. "h2.np-title": tag + its
 * most stable feature. Meant to match its look-alikes too (the picker
 * shows "selector · N").
 */
export function selectorFor(el: DomElement): string {
  return `${tagOf(el)}${featuresOf(el)[0] ?? ""}`;
}

function isInside(el: DomElement, ancestor: DomElement): boolean {
  for (let node: DomElement | null = el; node; node = node.parentElement) {
    if (node === ancestor) return true;
  }
  return false;
}

function firstMatch(root: DomQueryRoot, selector: string): DomElement | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * A selector for a field, relative to its card: the first match of it
 * in `card` is `el` (that is how the engine reads it). ":scope" when
 * `el` is the card; null when `el` is not inside `card`.
 */
export function fieldSelectorFor(el: DomElement, card: DomElement): string | null {
  if (el === card) return ":scope";
  if (!isInside(el, card)) return null;
  const tag = tagOf(el);
  const features = featuresOf(el);
  const own = [...new Set([...features.map((f) => `${tag}${f}`), ...features, tag])];
  for (const candidate of own) {
    if (firstMatch(card, candidate) === el) return candidate;
  }
  for (let anc = el.parentElement; anc && anc !== card; anc = anc.parentElement) {
    const ancTag = tagOf(anc);
    for (const prefix of featuresOf(anc).map((f) => `${ancTag}${f}`)) {
      for (const candidate of own) {
        const selector = `${prefix} ${candidate}`;
        if (firstMatch(card, selector) === el) return selector;
      }
    }
  }
  return `:scope > ${nthPath(el, card)}`;
}

/** "div:nth-of-type(2) > span:nth-of-type(1)" from below `root` down to `el`. */
function nthPath(el: DomElement, root: DomElement): string {
  const parts: string[] = [];
  for (let node: DomElement | null = el; node && node !== root; node = node.parentElement) {
    const current = node;
    const parent = current.parentElement;
    const tag = tagOf(current);
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((s) => s.tagName === current.tagName);
    parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(current) + 1})`);
  }
  return parts.join(" > ");
}

/** A card needs this many look-alike siblings (itself included) to count as repeating. */
export const MIN_SIMILAR_SIBLINGS = 3;

/** Same tag and a shared stable feature (or neither has any). */
function sameShape(a: DomElement, b: DomElement): boolean {
  if (a.tagName !== b.tagName) return false;
  const fa = featuresOf(a);
  const fb = new Set(featuresOf(b));
  if (fa.length === 0 && fb.size === 0) return true;
  return fa.some((feature) => fb.has(feature));
}

export type InferItemResult =
  | {
      ok: true;
      /** The card that holds the clicked element. */
      card: DomElement;
      /** Matches this card and its look-alikes on the page. */
      selector: string;
      /** How many elements `selector` matches in `root`. */
      count: number;
    }
  | { ok: false; reason: "not-repeated" };

/**
 * The content card around a clicked element: the nearest ancestor (or
 * the element itself) with at least `MIN_SIMILAR_SIBLINGS` look-alike
 * siblings, generalized into the selector that covers all of them, holds
 * no element of another shape, and — among those — the most cards on the
 * page (a second list of the same cards counts in). Featureless cards
 * get their container in the selector ("ul.threads > li").
 */
export function inferItem(el: DomElement, root: DomQueryRoot): InferItemResult {
  for (let node: DomElement | null = el; node; node = node.parentElement) {
    const parent: DomElement | null = node.parentElement;
    if (!parent || /^(?:html|body)$/i.test(node.tagName)) break;
    const card = node;
    const similar = Array.from(parent.children).filter((s) => sameShape(s, card));
    if (similar.length >= MIN_SIMILAR_SIBLINGS) return generalize(card, similar, parent, root);
  }
  return { ok: false, reason: "not-repeated" };
}

function generalize(
  card: DomElement,
  similar: DomElement[],
  parent: DomElement,
  root: DomQueryRoot,
): InferItemResult {
  const tag = tagOf(card);
  const common = featuresOf(card).filter((feature) =>
    similar.every((s) => featuresOf(s).includes(feature)),
  );
  const own = [...common.map((f) => `${tag}${f}`), tag];
  const parentSelector = selectorFor(parent);
  const candidates = [...own, ...own.map((selector) => `${parentSelector} > ${selector}`)];

  // A featureless card ("li") can only be told from other featureless
  // elements by where it sits: then only its own siblings look alike.
  const featureless = featuresOf(card).length === 0;
  const lookAlike = (m: DomElement): boolean =>
    sameShape(m, card) && (!featureless || m.parentElement === parent);

  let best: { selector: string; count: number; strays: number } | undefined;
  for (const selector of candidates) {
    const found = selectAll(root, selector);
    if (!found.ok) continue;
    const matched = new Set(found.elements);
    if (!similar.every((s) => matched.has(s))) continue;
    const strays = found.elements.filter((m) => !lookAlike(m)).length;
    const count = found.elements.length;
    const better =
      !best ||
      strays < best.strays ||
      (strays === best.strays && strays === 0 && count > best.count) ||
      (strays === best.strays && strays > 0 && count < best.count);
    if (better) best = { selector, count, strays };
  }
  if (!best) {
    // Unreachable in a real DOM (the tag alone covers the siblings); stay honest anyway.
    return { ok: false, reason: "not-repeated" };
  }
  return { ok: true, card, selector: best.selector, count: best.count };
}

export type DistinguishResult =
  | {
      ok: true;
      /** For `item.exclude`: a card matching it is dropped (".ad", ":has(.sponsor)"). */
      exclude: string;
      /** Cards it drops, the clicked one included ("2 cards excluded"). */
      removed: number;
    }
  | { ok: false; reason: "no-distinguishing-feature" };

/** Descendants looked at for a distinguishing feature (cards are small). */
const MAX_SCANNED_DESCENDANTS = 300;

/**
 * "Not this one": a feature the excluded card has and at most a third
 * of the other cards share — a feature on the card itself, else
 * `:has(feature)` of something inside it. The fewest other cards wins.
 * When none qualifies the exclusion cannot be written into a rule, and
 * the result says so (the picker tells the user; it never guesses).
 */
export function distinguishing(
  card: DomElement,
  cards: ArrayLike<DomElement>,
): DistinguishResult {
  const others = Array.from(cards).filter((c) => c !== card);
  const limit = Math.floor(others.length / 3);

  const candidates: string[] = [...featuresOf(card), ...dataAttrsOf(card)];
  const inside = selectAll(card, "*");
  if (inside.ok) {
    for (const el of inside.elements.slice(0, MAX_SCANNED_DESCENDANTS)) {
      for (const feature of [...featuresOf(el), ...dataAttrsOf(el)]) {
        candidates.push(`:has(${feature})`);
      }
    }
  }

  let best: { exclude: string; shared: number } | undefined;
  for (const candidate of new Set(candidates)) {
    if (!matchesSafe(card, candidate)) continue;
    const shared = others.filter((other) => matchesSafe(other, candidate)).length;
    if (shared <= limit && (!best || shared < best.shared))
      best = { exclude: candidate, shared };
  }
  if (!best) return { ok: false, reason: "no-distinguishing-feature" };
  return { ok: true, exclude: best.exclude, removed: best.shared + 1 };
}

/** Presence of plain `data-*` attributes ("[data-ad]"), test ids excluded. */
function dataAttrsOf(el: DomElement): string[] {
  const names: string[] = [];
  for (let i = 0; i < el.attributes.length; i += 1) {
    const name = el.attributes[i]?.name.toLowerCase();
    if (name?.startsWith("data-") && !TEST_ATTRS.includes(name) && SAFE_IDENT.test(name)) {
      names.push(`[${name}]`);
    }
  }
  return names;
}

function matchesSafe(el: DomElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}
