import { t, type MessageKey } from "./i18n.js";

/**
 * Localizes a static extension page (options.html, popup.html): every
 * element with `data-i18n="<key>"` gets that message as its content and
 * `<html lang>` follows the UI language. In a message, `<b>`, `<em>` and
 * `<code>` become those elements; any other text (a `<` included) stays
 * plain text, so no message is ever parsed as HTML.
 */

const INLINE = /<(b|em|code)>(.*?)<\/\1>/g;

export function richText(doc: Document, text: string): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > at) nodes.push(doc.createTextNode(text.slice(at, match.index)));
    const el = doc.createElement(match[1] === "b" ? "strong" : (match[1] ?? "span"));
    el.textContent = match[2] ?? "";
    nodes.push(el);
    at = match.index + match[0].length;
  }
  if (at < text.length) nodes.push(doc.createTextNode(text.slice(at)));
  return nodes;
}

export function localizePage(doc: Document): void {
  doc.documentElement.lang = t("langCode");
  for (const el of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.replaceChildren(...richText(doc, t(el.dataset["i18n"] as MessageKey)));
  }
}
