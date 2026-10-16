import { SiteRuleSchema, type UiLang } from "@nmc/core";
import { setUiLang, watchUiLang } from "./i18n.js";
import { PickerUI, type Theme } from "./picker/picker-ui.js";
import { isSitePickerInitMessage, type SiteWorkerMessage } from "./sites/site-messages.js";

/**
 * The picker's content script: injected by the worker (ISOLATED world)
 * only into the tab it opened for "Add site" / "Re-pick", never declared
 * in the manifest. It waits for the worker's init message, then mounts
 * the overlay (picker/picker-ui.ts).
 */

const THEME_KEY = "nmc.pickerTheme";
const LOADED = "__nmcPicker";
const scope = globalThis as unknown as Record<string, unknown>;

let current: PickerUI | null = null;

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

if (!scope[LOADED]) {
  scope[LOADED] = true;
  // The overlay opens in the desktop's language; a change made while it
  // is open shows on its next open, never half-way through.
  let nextLang: UiLang | undefined;
  const langReady = watchUiLang((lang) => {
    nextLang = lang;
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isSitePickerInitMessage(message)) return;
    const rule = message.rule ? SiteRuleSchema.safeParse(message.rule) : undefined;
    void langReady.then(() => {
      if (nextLang) setUiLang(nextLang);
      current?.destroy();
      current = new PickerUI(
        {
          doc: document,
          win: window,
          send: (out: SiteWorkerMessage) => chrome.runtime.sendMessage(out),
          now: () => new Date().toISOString(),
          loadTheme: async () => {
            const stored = (await chrome.storage.local.get(THEME_KEY))[THEME_KEY];
            return isTheme(stored) ? stored : "system";
          },
          saveTheme: (theme) => void chrome.storage.local.set({ [THEME_KEY]: theme }),
        },
        { target: message.target, ...(rule?.success ? { rule: rule.data } : {}) },
      );
      void current.mount();
    });
    sendResponse({ mounted: true });
  });
}
