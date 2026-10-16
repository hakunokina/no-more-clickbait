import { resolveUiLang, UiLanguageSchema, type UiLang } from "@nmc/core";
import { EN, TR, type MessageKey } from "./i18n/messages.js";
import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * UI text in the language the desktop app is set to (English default,
 * Turkish; leader decision #778): the managed setting `uiLanguage`,
 * stored with the other settings in chrome.storage.local. "system" (or
 * nothing stored yet) follows the browser's first language — Turkish
 * for `tr*`, English for anything else. Messages live in
 * `i18n/messages.ts`; `_locales` is built from them only for the
 * manifest's name and description, which the browser localizes itself.
 */

export type { MessageKey };
export type MessageArg = string | number;

/** A message to show later: key + its `$1`… arguments (an argument may be a message itself). */
export interface Msg {
  key: MessageKey;
  args?: (MessageArg | Msg)[];
}

const TABLES: Readonly<Record<UiLang, Readonly<Record<MessageKey, string>>>> = {
  en: EN,
  tr: TR,
};

const browserLocales = (): readonly string[] => globalThis.navigator?.languages ?? [];

/** The language `uiLanguage` in these stored settings asks for. */
export function langOf(settings: unknown): UiLang {
  const choice = UiLanguageSchema.safeParse(
    (settings as { uiLanguage?: unknown } | undefined)?.uiLanguage,
  );
  return resolveUiLang(choice.success ? choice.data : "system", browserLocales());
}

/** English until `watchUiLang` has read the stored language. */
let current: UiLang = "en";

export function uiLang(): UiLang {
  return current;
}

export function setUiLang(lang: UiLang): void {
  current = lang;
}

/**
 * Takes the stored language now (`uiLang()` once this resolves) and
 * calls `onChange` each time a later settings change resolves to another
 * language. The caller decides when the page switches (`setUiLang`): at
 * once, or on a reload.
 */
export async function watchUiLang(onChange: (lang: UiLang) => void): Promise<void> {
  let seen = current;
  let changed = false;
  let loaded = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[SETTINGS_STORAGE_KEY];
    if (area !== "local" || !change) return;
    changed = true;
    const lang = langOf(change.newValue);
    if (lang === seen) return;
    seen = lang;
    if (loaded) onChange(lang);
  });
  const stored: Record<string, unknown> = await chrome.storage.local
    .get(SETTINGS_STORAGE_KEY)
    .catch(() => ({}));
  // A change that landed while reading is newer than what was read.
  if (!changed) seen = langOf(stored[SETTINGS_STORAGE_KEY]);
  setUiLang(seen);
  loaded = true;
}

/** `$1`…`$9` replaced by the arguments (missing ones become ""). */
export function format(template: string, args: readonly MessageArg[]): string {
  return template.replace(/\$([1-9])/g, (_, n: string) => String(args[Number(n) - 1] ?? ""));
}

export function t(key: MessageKey, ...args: MessageArg[]): string {
  return format(TABLES[current][key], args);
}

export function tm(msg: Msg): string {
  return t(
    msg.key,
    ...(msg.args ?? []).map((arg) => (typeof arg === "object" ? tm(arg) : arg)),
  );
}
