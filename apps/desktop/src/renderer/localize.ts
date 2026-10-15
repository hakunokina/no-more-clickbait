import type { UiLang } from "@nmc/core";
import { messages, type DesktopMessages } from "../shared/i18n.js";

/**
 * A window's static words: every `data-i18n="<key>"` element gets that
 * message (plain-text messages only), plus the document's language and,
 * when given, title. The page stays hidden until then
 * (`data-i18n-pending`), so a Turkish user never sees the markup's
 * English first.
 */
export function localizePage(doc: Document, lang: UiLang, title?: string): void {
  const m = messages(lang);
  doc.documentElement.lang = lang;
  if (title !== undefined) doc.title = title;
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const value = m[element.dataset["i18n"] as keyof DesktopMessages];
    if (typeof value === "string") element.textContent = value;
  }
  doc.documentElement.removeAttribute("data-i18n-pending");
}
