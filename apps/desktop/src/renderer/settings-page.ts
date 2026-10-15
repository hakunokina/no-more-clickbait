import type { DesktopApi } from "../preload/preload.js";
import type { SettingsStatus } from "../shared/settings-status.js";
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

form.element.addEventListener("input", () => {
  dirty = true;
});

function renderBrowsers(status: SettingsStatus): void {
  const options: { value: string; label: string }[] = [
    { value: "default", label: "System default browser" },
    ...status.browsers.map((browser) => ({
      value: browser.family,
      label: browser.systemDefault ? `${browser.label} (system default)` : browser.label,
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

  el("browser-note").textContent =
    status.collectBrowserProblem ??
    (status.collectBrowserLabel
      ? `Collections run in ${status.collectBrowserLabel}${status.browserConnected ? " (extension connected)" : " (extension not connected right now)"}.`
      : "");
}

function render(status: SettingsStatus): void {
  renderBrowsers(status);
  // A push from the other side never overwrites what is being typed.
  if (!dirty && status.stamp.updatedAt !== lastStamp) {
    lastStamp = status.stamp.updatedAt;
    form.fill(status.settings);
  }
  el("pending-note").textContent = status.pending
    ? status.browserConnected
      ? "Sending the change to the extension…"
      : "Saved here — it will be applied when the browser connects."
    : "";
  el("mode-b-note").textContent = status.modeBPermissionMissing
    ? "Mode B stayed off: only the extension's options page can ask the browser for its “alarms” permission. Turn Mode B on there once."
    : "";
}

el("save").addEventListener("click", () => {
  const result = form.read();
  if (!result.ok) {
    form.showErrors(result.errors);
    el("save-note").textContent = "Nothing saved — check the marked fields.";
    return;
  }
  form.showErrors({});
  el("save-note").textContent = "Saving…";
  window.nmc
    .updateSettings(result.settings)
    .then(() => {
      dirty = false;
      el("save-note").textContent = "Saved.";
    })
    .catch((error: unknown) => {
      el("save-note").textContent = `Could not save: ${String(error)}`;
    });
});

choiceSelect.addEventListener("change", () => {
  void window.nmc
    .setBrowserChoice(choiceSelect.value as SettingsStatus["choice"])
    .catch((error: unknown) => {
      el("browser-note").textContent = `Could not save the browser choice: ${String(error)}`;
    });
});

window.nmc.onSettingsStatus(render);
void window.nmc.getSettingsStatus().then(render);
