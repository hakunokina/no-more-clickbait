import { settingCopy, type UiLang } from "@nmc/core";
import type { DesktopApi } from "../preload/preload.js";
import { messages, say } from "../shared/i18n.js";
import type { SettingsStatus } from "../shared/settings-status.js";
import { localizePage } from "./localize.js";
import { SettingsAutoSave, type AutoSaveState } from "./settings-autosave.js";
import { buildSettingsForm } from "./settings-form.js";
import { loadSettings } from "./settings-load.js";

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
// Shown with the language, but saved on its own (setBrowserChoice), not with the form.
form.insertField("browser", el("browser-field"));
// Locked until the real settings are in: its starting values are only defaults.
form.element.inert = true;
let latest: SettingsStatus | null = null;
let lang: UiLang = "en";
type SaveTone = "plain" | "ok" | "bad";
/** The save line, re-worded when the language changes. */
let saveLine: ((lang: UiLang) => string) | null = null;
let saveTone: SaveTone = "plain";
let savedNoteTimer: ReturnType<typeof setTimeout> | undefined;

function showSave(line: ((lang: UiLang) => string) | null, tone: SaveTone = "plain"): void {
  saveLine = line;
  saveTone = tone;
  el("save-note").textContent = line ? line(lang) : "";
  const box = el("save-box");
  box.classList.toggle("save--bad", tone === "bad");
  const mark = box.querySelector("svg");
  mark?.toggleAttribute("hidden", tone === "plain");
  mark?.querySelector("use")?.setAttribute("href", tone === "ok" ? "#i-check" : "#i-warn");
}

function showSaveState(state: AutoSaveState): void {
  clearTimeout(savedNoteTimer);
  switch (state.kind) {
    case "saving":
      showSave((l) => messages(l).saving);
      return;
    case "saved":
      showSave((l) => messages(l).saved, "ok");
      savedNoteTimer = setTimeout(() => showSave(null), SAVED_NOTE_MS);
      break;
    case "invalid":
      showSave((l) => messages(l).saveInvalid, "bad");
      break;
    case "failed":
      showSave((l) => messages(l).saveFailed(state.error), "bad");
      return;
  }
  // Settled: what the other side changed meanwhile can show now.
  if (latest) autosave.show(latest.stamp, latest.settings);
}

const autosave = new SettingsAutoSave({
  read: (base) => form.read(base),
  fill: (settings) => form.fill(settings),
  save: (settings) => window.nmc.updateSettings(settings),
  showErrors: (errors) => form.showErrors(errors),
  onState: showSaveState,
});

// Number fields save once typing pauses; ticks, choices and a field left save at once.
form.element.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "number") {
    autosave.typed();
  }
});
form.element.addEventListener("change", (event) => {
  if (event.target === choiceSelect) return;
  void autosave.flush();
});
// Enter in a number field would submit the (button-less) form: save instead.
form.element.addEventListener("submit", (event) => {
  event.preventDefault();
  void autosave.flush();
});
window.nmc.onFlushSettings(() => autosave.flush());

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
    showSave(saveLine, saveTone);
  }
  const m = messages(lang);
  renderBrowsers(status);
  // A push from the other side never overwrites what is being typed.
  latest = status;
  autosave.show(status.stamp, status.settings);
  form.element.inert = false;
  el("load-note").textContent = "";
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
// Without a status the page still shows, in the system's language, with the
// form locked: saving its default values would overwrite the real settings.
loadSettings({
  get: () => window.nmc.getSettingsStatus(),
  render,
  unreadable: (systemLang) => {
    if (latest) return;
    lang = systemLang;
    localizePage(document, lang, messages(lang).settingsWindowTitle);
    form.setLanguage(lang);
    el("load-note").textContent = messages(lang).settingsUnreadable;
  },
  systemLocales: navigator.languages,
});
