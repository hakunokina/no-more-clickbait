import type { UiLang } from "@nmc/core";
import type { DesktopApi } from "../preload/preload.js";
import { messages, say } from "../shared/i18n.js";
import type { SettingsStatus } from "../shared/settings-status.js";
import { localizePage } from "./localize.js";
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

const form = buildSettingsForm(el("settings-form"));
const choiceSelect = el<HTMLSelectElement>("browser-choice");
let dirty = false;
let lastStamp = "";
let lang: UiLang = "en";
/** The save line, re-worded when the language changes. */
let saveLine: ((lang: UiLang) => string) | null = null;

form.element.addEventListener("input", () => {
  dirty = true;
});

function showSave(line: ((lang: UiLang) => string) | null): void {
  saveLine = line;
  el("save-note").textContent = line ? line(lang) : "";
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
  if (!dirty && status.stamp.updatedAt !== lastStamp) {
    lastStamp = status.stamp.updatedAt;
    form.fill(status.settings);
  }
  el("pending-note").textContent = status.pending
    ? status.browserConnected
      ? m.pendingSending
      : m.pendingSavedHere
    : "";
  el("mode-b-note").textContent = status.modeBPermissionMissing ? m.modeBStayedOff : "";
}

el("save").addEventListener("click", () => {
  const result = form.read();
  if (!result.ok) {
    form.showErrors(result.errors);
    showSave((l) => messages(l).saveInvalid);
    return;
  }
  form.showErrors({});
  showSave((l) => messages(l).saving);
  window.nmc
    .updateSettings(result.settings)
    .then(() => {
      dirty = false;
      showSave((l) => messages(l).saved);
    })
    .catch((error: unknown) => {
      showSave((l) => messages(l).saveFailed(String(error)));
    });
});

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
