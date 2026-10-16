import { resolveUiLang, UiLangSchema, UiLanguageSchema, type UiLang } from "@nmc/core";
import { EN, TR, type MessageKey } from "./i18n/messages.js";
import { DESKTOP_LANG_STORAGE_KEY, SETTINGS_STORAGE_KEY } from "./settings-key.js";

/**
 * UI text in the language the desktop app is set to (English default,
 * Turkish; leader decision #778): the managed setting `uiLanguage`,
 * stored with the other settings in chrome.storage.local. "system" (or
 * nothing stored yet) is the language the desktop app shows, which it
 * resolves against the OS and pushes (`ui-lang`, stored under
 * DESKTOP_LANG_STORAGE_KEY) — the browser's own language may be any
 * other. Only before the desktop app ever linked up does "system"
 * follow the browser's first language: Turkish for `tr*`, English for
 * anything else. Messages live in
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

/** The language these stored settings and the desktop's last stored language ask for. */
export function langOf(settings: unknown, desktopLang?: unknown): UiLang {
  const choice = UiLanguageSchema.safeParse(
    (settings as { uiLanguage?: unknown } | undefined)?.uiLanguage,
  );
  if (choice.success && choice.data !== "system") return choice.data;
  const desktop = UiLangSchema.safeParse(desktopLang);
  return desktop.success ? desktop.data : resolveUiLang("system", browserLocales());
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
  const keys = [SETTINGS_STORAGE_KEY, DESKTOP_LANG_STORAGE_KEY];
  const values: Record<string, unknown> = {};
  const changed = new Set<string>();
  let seen = current;
  let loaded = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !keys.some((key) => changes[key])) return;
    for (const key of keys) {
      const change = changes[key];
      if (!change) continue;
      changed.add(key);
      values[key] = change.newValue;
    }
    if (!loaded) return;
    const lang = langOf(values[SETTINGS_STORAGE_KEY], values[DESKTOP_LANG_STORAGE_KEY]);
    if (lang === seen) return;
    seen = lang;
    onChange(lang);
  });
  const stored: Record<string, unknown> = await chrome.storage.local
    .get(keys)
    .catch(() => ({}));
  // A change that landed while reading is newer than what was read.
  for (const key of keys) if (!changed.has(key)) values[key] = stored[key];
  seen = langOf(values[SETTINGS_STORAGE_KEY], values[DESKTOP_LANG_STORAGE_KEY]);
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
