import { z } from "zod";

/**
 * The UI's two languages (owner: English and Turkish) and the small,
 * dependency-free layer each package builds its own copy on:
 * - one message table per language; a message is plain text or a
 *   function of its arguments. `MessageTable<typeof en>` types the other
 *   table, so a missing key, an extra key or a different argument list
 *   fails to compile;
 * - `MessageRef`: a message by key and arguments, plain data, so it can
 *   cross IPC or sit in a status object and be put into words by
 *   whichever window shows it, in the language it shows;
 * - Intl for numbers, dates and plurals (`INTL_LOCALES`, `plural`).
 */

export const UI_LANGS = ["en", "tr"] as const;
export type UiLang = (typeof UI_LANGS)[number];

/** The user's choice; "system" follows the OS (`resolveUiLang`). */
export const UiLanguageSchema = z.enum(["system", "en", "tr"]);
export type UiLanguage = z.infer<typeof UiLanguageSchema>;

/** Intl locale per UI language (numbers, dates, plural rules, casing). */
export const INTL_LOCALES: Readonly<Record<UiLang, string>> = { en: "en-US", tr: "tr-TR" };

/**
 * The language to show. "system": Turkish when the OS's first preferred
 * language is Turkish (any region), English otherwise.
 */
export function resolveUiLang(choice: UiLanguage, systemLocales: readonly string[]): UiLang {
  if (choice !== "system") return choice;
  return /^tr(?:[-_]|$)/i.test(systemLocales[0] ?? "") ? "tr" : "en";
}

/** Plain text, or a function of plain-data arguments. */
export type Message = string | ((...args: never[]) => string);

/** Another language's table for `T`: the same keys, the same argument lists. */
export type MessageTable<T extends Record<string, Message>> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};

/** A message of table `T` by key, with its arguments (plain data, IPC-safe). */
export type MessageRef<T extends Record<string, Message>> = {
  [K in keyof T & string]: T[K] extends (...args: infer A) => string
    ? { key: K; args: A }
    : { key: K };
}[keyof T & string];

/** Puts a `MessageRef` into words with `table`. */
export function formatMessage<T extends Record<string, Message>>(
  table: T,
  ref: MessageRef<T>,
): string {
  const message = table[ref.key] as Message;
  if (typeof message === "string") return message;
  const args = "args" in ref ? (ref.args as never[]) : [];
  return message(...args);
}

/** "one" or "other" by the language's plural rules (Turkish nouns do not inflect). */
export function plural(
  lang: UiLang,
  count: number,
  forms: { one: string; other: string },
): string {
  return new Intl.PluralRules(INTL_LOCALES[lang]).select(count) === "one"
    ? forms.one
    : forms.other;
}

/** Keys of `a` and `b` differ, or a message takes a different number of arguments. */
export function tableMismatches(
  a: Readonly<Record<string, Message>>,
  b: Readonly<Record<string, Message>>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined || typeof x !== typeof y) return true;
    return typeof x === "function" && typeof y === "function" && x.length !== y.length;
  });
}
