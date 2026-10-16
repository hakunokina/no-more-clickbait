import { resolveUiLang, type UiLang } from "@nmc/core";

/** How long Settings waits for main's first answer before it shows the page locked. */
export const SETTINGS_WAIT_MS = 5_000;

export interface SettingsLoad<T> {
  get(): Promise<T>;
  render(status: T): void;
  /** No settings to show: the page shows, locked, in `lang` (the system's language). */
  unreadable(lang: UiLang): void;
  /** The system's languages, most preferred first (`navigator.languages`). */
  systemLocales: readonly string[];
  waitMs?: number;
}

/**
 * Asks main for the settings. When it refuses, or does not answer in
 * time (main hung), `unreadable` runs — once — so the page does not stay
 * blank; a status that comes later still renders (and unlocks it).
 */
export function loadSettings<T>(load: SettingsLoad<T>): void {
  let gaveUp = false;
  const giveUp = (): void => {
    clearTimeout(timer);
    if (gaveUp) return;
    gaveUp = true;
    load.unreadable(resolveUiLang("system", load.systemLocales));
  };
  const timer = setTimeout(giveUp, load.waitMs ?? SETTINGS_WAIT_MS);
  load.get().then((status) => {
    clearTimeout(timer);
    load.render(status);
  }, giveUp);
}
