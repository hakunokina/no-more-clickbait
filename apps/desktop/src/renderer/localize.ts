import type { UiLang } from "@nmc/core";
import { messages, type DesktopMessages } from "../shared/i18n.js";

/**
 * A window's static words: every `data-i18n="<key>"` element gets that
 * message (plain-text messages only; the markup keeps the English as a
 * first paint), plus the document's language and, when given, title.
 */
export function localizePage(doc: Document, lang: UiLang, title?: string): void {
  const m = messages(lang);
  doc.documentElement.lang = lang;
  if (title !== undefined) doc.title = title;
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const value = m[element.dataset["i18n"] as keyof DesktopMessages];
    if (typeof value === "string") element.textContent = value;
  }
}
