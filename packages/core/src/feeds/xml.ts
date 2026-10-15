/**
 * A small, strict-enough XML reader for RSS/Atom feeds.
 *
 * Why not `DOMParser`: an MV3 service worker has none, and the desktop
 * and native host run on Node. With this, a feed can be read wherever
 * it is fetched — no offscreen document for the simplest, sturdiest
 * collection path.
 *
 * What it does: elements, attributes, text, CDATA; the five predefined
 * entities and numeric references. What it skips: comments, processing
 * instructions, the DOCTYPE (internal subset included). DTD entities are
 * never expanded — so no entity bombs, no external fetches; an unknown
 * `&name;` stays as written. Mismatched or unclosed tags throw
 * `XmlParseError`.
 */

export interface XmlElement {
  /** Qualified name as written ("item", "dc:creator", "media:content"). */
  name: string;
  attrs: Record<string, string>;
  children: XmlChild[];
}
export type XmlChild = XmlElement | string;

export class XmlParseError extends Error {
  override name = "XmlParseError";
}

/** Larger inputs are refused rather than parsed. */
export const MAX_XML_CHARS = 5_000_000;

/** Deeper nesting is refused (no feed nests this deep; readers recurse). */
export const MAX_XML_DEPTH = 64;

const NAME = /[^\s/>=]+/y;

export function parseXml(xml: string): XmlElement {
  if (xml.length > MAX_XML_CHARS) throw new XmlParseError("document too large");
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = 0;

  const skipPast = (end: string, what: string): void => {
    const at = src.indexOf(end, i);
    if (at < 0) throw new XmlParseError(`unclosed ${what}`);
    i = at + end.length;
  };
  const appendText = (text: string): void => {
    const top = stack[stack.length - 1];
    if (top && text) top.children.push(text);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeXmlEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeXmlEntities(src.slice(i, lt)));
    i = lt;

    if (src.startsWith("<!--", i)) {
      skipPast("-->", "comment");
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end < 0) throw new XmlParseError("unclosed CDATA section");
      appendText(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      skipPast("?>", "processing instruction");
    } else if (src.startsWith("<!", i)) {
      skipDoctype();
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      if (end < 0) throw new XmlParseError("unclosed end tag");
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new XmlParseError(`</${name}> does not close <${open?.name ?? "nothing"}>`);
      }
      if (stack.length === 0) {
        root = open;
        break;
      }
      i = end + 1;
    } else {
      const element = readStartTag();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element.el);
      else if (root) break;
      if (element.selfClosing) {
        if (!parent) {
          root = element.el;
          break;
        }
      } else {
        if (stack.length >= MAX_XML_DEPTH) throw new XmlParseError("nesting too deep");
        stack.push(element.el);
      }
    }
  }
  if (stack.length > 0)
    throw new XmlParseError(`<${stack[stack.length - 1]?.name}> is not closed`);
  if (!root) throw new XmlParseError("no root element");
  return root;

  function skipDoctype(): void {
    let depth = 0;
    for (let j = i + 2; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      else if (ch === ">" && depth <= 0) {
        i = j + 1;
        return;
      }
    }
    throw new XmlParseError("unclosed DOCTYPE");
  }

  function readStartTag(): { el: XmlElement; selfClosing: boolean } {
    NAME.lastIndex = i + 1;
    const name = NAME.exec(src)?.[0];
    if (!name) throw new XmlParseError(`bad tag at ${i}`);
    const el: XmlElement = { name, attrs: {}, children: [] };
    i = NAME.lastIndex;
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      if (src.startsWith("/>", i)) {
        i += 2;
        return { el, selfClosing: true };
      }
      if (src[i] === ">") {
        i += 1;
        return { el, selfClosing: false };
      }
      NAME.lastIndex = i;
      const attr = NAME.exec(src)?.[0];
      if (!attr) throw new XmlParseError(`bad attribute in <${name}>`);
      i = NAME.lastIndex;
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      if (src[i] !== "=")
        throw new XmlParseError(`attribute ${attr} in <${name}> has no value`);
      i += 1;
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(`attribute ${attr} in <${name}> is not quoted`);
      }
      const end = src.indexOf(quote, i + 1);
      if (end < 0) throw new XmlParseError(`unclosed attribute ${attr} in <${name}>`);
      el.attrs[attr] = decodeXmlEntities(src.slice(i + 1, end));
      i = end + 1;
    }
  }
}

const PREDEFINED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** The five predefined entities and numeric references; anything else stays as written. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) return fromCodePoint(ref, whole);
    return PREDEFINED[ref] ?? whole;
  });
}

/** "#x41" / "#65" → "A"; an invalid code point keeps the reference as written. */
export function fromCodePoint(ref: string, whole: string): string {
  const code =
    ref[1] === "x" || ref[1] === "X"
      ? Number.parseInt(ref.slice(2), 16)
      : Number.parseInt(ref.slice(1), 10);
  if (
    !Number.isFinite(code) ||
    code <= 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return whole;
  }
  return String.fromCodePoint(code);
}

/** "dc:creator" → "creator". */
export function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/** Child elements, optionally only those with this local name. */
export function childElements(el: XmlElement, local?: string): XmlElement[] {
  return el.children.filter(
    (child): child is XmlElement =>
      typeof child !== "string" && (local === undefined || localName(child.name) === local),
  );
}

/** The first child with this exact qualified name, else with this local name. */
export function childElement(el: XmlElement, name: string): XmlElement | undefined {
  const elements = childElements(el);
  return (
    elements.find((child) => child.name === name) ??
    (name.includes(":") ? undefined : elements.find((child) => localName(child.name) === name))
  );
}

/** All text below `el`, CDATA included, in order. */
export function xmlText(el: XmlElement | undefined): string {
  if (!el) return "";
  return el.children
    .map((child) => (typeof child === "string" ? child : xmlText(child)))
    .join("");
}
