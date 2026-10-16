import { EN, type MessageKey } from "./i18n/messages.js";

/**
 * UI text through `chrome.i18n` (English default, Turkish; leader
 * decision #778). Messages live in `i18n/messages.ts`; the build writes
 * them out as `_locales/<lang>/messages.json` (positional `$1`… become
 * named placeholders). Where `chrome.i18n` is missing (tests) or has no
 * entry, the English text is used, so a key never shows raw.
 */

export type { MessageKey };
export type MessageArg = string | number;

/** A message to show later: key + its `$1`… arguments (an argument may be a message itself). */
export interface Msg {
  key: MessageKey;
  args?: (MessageArg | Msg)[];
}

/** `$1`…`$9` replaced by the arguments (missing ones become ""). */
export function format(template: string, args: readonly MessageArg[]): string {
  return template.replace(/\$([1-9])/g, (_, n: string) => String(args[Number(n) - 1] ?? ""));
}

export function t(key: MessageKey, ...args: MessageArg[]): string {
  const subs = args.map(String);
  try {
    const i18n = (globalThis as { chrome?: typeof chrome }).chrome?.i18n;
    const text = i18n?.getMessage(key, subs);
    if (text) return text;
  } catch {
    // No extension context (tests): fall back to English below.
  }
  return format(EN[key], subs);
}

export function tm(msg: Msg): string {
  return t(
    msg.key,
    ...(msg.args ?? []).map((arg) => (typeof arg === "object" ? tm(arg) : arg)),
  );
}
