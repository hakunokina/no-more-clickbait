import { ManagedSettingsSchema, settingCopy, type UiLang } from "@nmc/core";
import type { DesktopApi } from "../preload/preload.js";
import { messages, say } from "../shared/i18n.js";
import type { SettingsStatus } from "../shared/settings-status.js";
import { localizePage } from "./localize.js";
import { SettingsAutoSave, type AutoSaveState } from "./settings-autosave.js";
import { buildSettingsForm } from "./settings-form.js";

declare global {
  interface Window {
    nmc: DesktopApi;
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

/** How long "Saved." stays before the line clears. */
const SAVED_NOTE_MS = 2_500;

const form = buildSettingsForm(el("settings-form"));
const choiceSelect = el<HTMLSelectElement>("browser-choice");
/** The stamped settings the form was last filled with. */
let filled = "";
let latest: SettingsStatus | null = null;
let lang: UiLang = "en";
/** The save line, re-worded when the language changes. */
let saveLine: ((lang: UiLang) => string) | null = null;
let savedNoteTimer: ReturnType<typeof setTimeout> | undefined;

function showSave(line: ((lang: UiLang) => string) | null): void {
  saveLine = line;
  el("save-note").textContent = line ? line(lang) : "";
}

function showSaveState(state: AutoSaveState): void {
  clearTimeout(savedNoteTimer);
  switch (state.kind) {
    case "saving":
      showSave((l) => messages(l).saving);
      return;
    case "saved":
      showSave((l) => messages(l).saved);
      savedNoteTimer = setTimeout(() => showSave(null), SAVED_NOTE_MS);
      break;
    case "invalid":
      showSave((l) => messages(l).saveInvalid);
      break;
    case "failed":
      showSave((l) => messages(l).saveFailed(state.error));
      return;
  }
  // Settled: what the other side changed meanwhile can show now.
  fillFromLatest();
}

const autosave = new SettingsAutoSave(
  {
    read: (base) => form.read(base),
    save: (settings) => window.nmc.updateSettings(settings),
    showErrors: (errors) => form.showErrors(errors),
    onState: showSaveState,
  },
  ManagedSettingsSchema.parse({}),
);

// Number fields save once typing pauses; ticks, choices and a field left save at once.
form.element.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "number") {
    autosave.typed();
  }
});
form.element.addEventListener("change", () => {
  void autosave.flush();
});
// Enter in a number field would submit the (button-less) form: save instead.
form.element.addEventListener("submit", (event) => {
  event.preventDefault();
  void autosave.flush();
});
window.nmc.onFlushSettings(() => autosave.flush());

/**
 * Shows the latest settings unless the form holds edits of its own. A
 * push answer may carry the stamp just saved with other values (the
 * extension could not apply some), so the values count too.
 */
function fillFromLatest(): void {
  if (!latest || autosave.busy) return;
  const key = JSON.stringify([latest.stamp, latest.settings]);
  if (key === filled) return;
  filled = key;
  form.fill(latest.settings);
  autosave.reset(latest.settings);
}

function renderBrowsers(status: SettingsStatus): void {
  const m = messages(lang);
  const options: { value: string; label: string }[] = [
    { value: "default", label: m.browserSystemDefault },
    ...status.browsers.map((browser) => ({
      value: browser.family,
      label: browser.systemDefault ? m.browserIsDefault(browser.label) : browser.label,
    })),
  ];
  const current = choiceSelect.value;
  choiceSelect.replaceChildren();
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    choiceSelect.append(element);
  }
  choiceSelect.value = options.some((option) => option.value === status.choice)
    ? status.choice
    : current || "default";

  el("browser-note").textContent = status.collectBrowserProblem
    ? say(lang, status.collectBrowserProblem)
    : status.collectBrowserLabel
      ? m.collectsIn(status.collectBrowserLabel, status.browserConnected)
      : "";
}

function render(status: SettingsStatus): void {
  if (status.lang !== lang || document.documentElement.hasAttribute("data-i18n-pending")) {
    lang = status.lang;
    localizePage(document, lang, messages(lang).settingsWindowTitle);
    form.setLanguage(lang);
    showSave(saveLine);
  }
  const m = messages(lang);
  renderBrowsers(status);
  // A push from the other side never overwrites what is being typed.
  latest = status;
  fillFromLatest();
  el("outdated-note").textContent =
    status.extensionMissing.length > 0
      ? m.extensionOutdated(status.extensionMissing.map((key) => settingCopy(lang, key).label))
      : "";
  el("pending-note").textContent = status.pending
    ? status.browserConnected
      ? m.pendingSending
      : m.pendingSavedHere
    : "";
  el("mode-b-note").textContent = status.modeBPermissionMissing ? m.modeBStayedOff : "";
}

choiceSelect.addEventListener("change", () => {
  void window.nmc
    .setBrowserChoice(choiceSelect.value as SettingsStatus["choice"])
    .catch((error: unknown) => {
      el("browser-note").textContent = messages(lang).choiceFailed(String(error));
    });
});

window.nmc.onSettingsStatus(render);
// Without a status the page still shows, in English.
void window.nmc.getSettingsStatus().then(render, () => localizePage(document, lang));
