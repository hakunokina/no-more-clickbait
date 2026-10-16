import type { UiLang } from "@nmc/core";

/**
 * The Options page switches language by reloading (every text, the
 * Sites section's included, comes back in the new language). It never
 * reloads over work in progress: while the page is busy (unsaved edits,
 * a delete's Undo window, an open dialog, a permission request) it only
 * says so, and reloads once the work is done.
 */

export interface LangReloadDeps {
  /** The language the page is shown in. */
  pageLang(): UiLang;
  busy(): boolean;
  reload(): void;
  /** True: a new language waits for the page to settle. */
  notePending(pending: boolean): void;
}

export interface LangReloader {
  /** The stored language changed. */
  changed(lang: UiLang): void;
  /** Something that kept the page busy finished. */
  settle(): void;
  pending(): boolean;
}

export function createLangReloader(deps: LangReloadDeps): LangReloader {
  let wanted: UiLang | undefined;
  let reloading = false;
  const settle = (): void => {
    if (wanted === undefined || reloading) return;
    if (deps.busy()) {
      deps.notePending(true);
      return;
    }
    reloading = true;
    deps.reload();
  };
  return {
    changed(lang) {
      if (lang === deps.pageLang()) {
        // Changed back before the page switched: nothing to do.
        if (wanted !== undefined) deps.notePending(false);
        wanted = undefined;
        return;
      }
      wanted = lang;
      settle();
    },
    settle,
    pending: () => wanted !== undefined && !reloading,
  };
}
