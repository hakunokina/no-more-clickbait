import { ModeBStrategySchema, SYNCED_SETTING_FIELDS, type SyncedSettings } from "@nmc/core";
import { bindModeBControls, requestModeBPermissions } from "./mode-b-view.js";
import {
  applyPipelineSettings,
  defaultSyncedSettings,
  readPipelineForm,
  SYNCED_SETTING_KEYS,
  type PipelineFormInput,
} from "./pipeline-form.js";
import { loadSettings, saveSettings } from "./settings.js";
import { describeSyncResult, sendNativeOnce, syncSettings } from "./settings-sync.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
const modeBStrategy = document.querySelector<HTMLSelectElement>("#mode-b-strategy");
const modeBRun = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
const modeBLastRun = document.querySelector<HTMLElement>("#mode-b-last-run");
const devCapture = document.querySelector<HTMLInputElement>("#dev-capture");
const pipelineFields = document.querySelector<HTMLElement>("#pipeline-fields");
const pipelineDefaults = document.querySelector<HTMLButtonElement>("#pipeline-defaults");
const status = document.querySelector<HTMLElement>("#status");
const syncStatus = document.querySelector<HTMLElement>("#sync-status");
const form = document.querySelector<HTMLFormElement>("#settings-form");

/** Settings that only matter while source checks are on. */
const VERIFY_DEPENDENT = new Set<string>(["minReadForVerify", "maxVerifications"]);

interface FieldControl {
  input: HTMLInputElement;
  error: HTMLElement;
  wrapper: HTMLElement;
}

/** Builds one labelled input per synced setting, straight from core's field table. */
function renderPipelineFields(container: HTMLElement): Map<string, FieldControl> {
  const controls = new Map<string, FieldControl>();
  for (const key of SYNCED_SETTING_KEYS) {
    const field = SYNCED_SETTING_FIELDS[key];
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.id = `setting-${key}`;
    input.name = key;
    if (field.kind === "boolean") {
      input.type = "checkbox";
      label.append(input, ` ${field.label}`);
    } else {
      input.type = "number";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "1";
      input.inputMode = "numeric";
      input.required = true;
      label.append(`${field.label} `, input);
    }
    const hint = document.createElement("p");
    hint.id = `${input.id}-hint`;
    hint.className = "hint";
    hint.textContent =
      field.kind === "boolean"
        ? `${field.description} Default: ${field.default ? "on" : "off"}.`
        : `${field.description} Range ${field.min}–${field.max}, default ${field.default}.`;
    const error = document.createElement("p");
    error.id = `${input.id}-error`;
    error.className = "error";
    input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
    wrapper.append(label, hint, error);
    container.append(wrapper);
    controls.set(key, { input, error, wrapper });
  }
  return controls;
}

function fillPipelineFields(controls: Map<string, FieldControl>, values: SyncedSettings): void {
  for (const key of SYNCED_SETTING_KEYS) {
    const control = controls.get(key);
    if (!control) continue;
    const value = values[key];
    if (typeof value === "boolean") control.input.checked = value;
    else control.input.value = String(value);
    control.input.removeAttribute("aria-invalid");
    control.error.textContent = "";
  }
  reflectVerifyEnabled(controls);
}

function reflectVerifyEnabled(controls: Map<string, FieldControl>): void {
  const verifyOn = controls.get("verifyEnabled")?.input.checked ?? true;
  for (const key of VERIFY_DEPENDENT) {
    const control = controls.get(key);
    if (!control) continue;
    control.input.disabled = !verifyOn;
    control.wrapper.classList.toggle("off", !verifyOn);
  }
}

function readPipelineFields(controls: Map<string, FieldControl>): PipelineFormInput {
  const input = {} as PipelineFormInput;
  for (const key of SYNCED_SETTING_KEYS) {
    const control = controls.get(key);
    const field = SYNCED_SETTING_FIELDS[key];
    input[key] =
      field.kind === "boolean" ? Boolean(control?.input.checked) : (control?.input.value ?? "");
  }
  return input;
}

async function init(): Promise<void> {
  if (
    !modeB ||
    !modeBStrategy ||
    !modeBRun ||
    !modeBStatus ||
    !devCapture ||
    !pipelineFields ||
    !pipelineDefaults ||
    !form ||
    !status ||
    !syncStatus
  ) {
    return;
  }
  let settings = await loadSettings();
  modeB.checked = settings.modeBEnabled;
  modeBStrategy.value = settings.modeBStrategy;
  devCapture.checked = settings.devCaptureEnabled;
  const controls = renderPipelineFields(pipelineFields);
  fillPipelineFields(controls, settings);
  controls.get("verifyEnabled")?.input.addEventListener("change", () => {
    reflectVerifyEnabled(controls);
  });
  pipelineDefaults.addEventListener("click", () => {
    fillPipelineFields(controls, defaultSyncedSettings());
    status.textContent = "Defaults restored in the form — press Save to keep them.";
  });
  bindModeBControls({ button: modeBRun, status: modeBStatus, lastRun: modeBLastRun });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pipeline = readPipelineForm(readPipelineFields(controls));
    for (const key of SYNCED_SETTING_KEYS) {
      const control = controls.get(key);
      if (!control) continue;
      const message = pipeline.ok ? undefined : pipeline.errors[key];
      control.error.textContent = message ?? "";
      if (message) control.input.setAttribute("aria-invalid", "true");
      else control.input.removeAttribute("aria-invalid");
    }
    if (!pipeline.ok) {
      const firstInvalid = SYNCED_SETTING_KEYS.find((key) => pipeline.errors[key]);
      if (firstInvalid) controls.get(firstInvalid)?.input.focus();
      status.textContent = "Not saved — fix the highlighted values first.";
      syncStatus.textContent = "";
      return;
    }
    // Asked while the click still counts as a user gesture.
    const permission = modeB.checked ? requestModeBPermissions() : Promise.resolve(true);
    void (async () => {
      const granted = await permission;
      if (!granted) modeB.checked = false;
      const strategy = ModeBStrategySchema.safeParse(modeBStrategy.value);
      try {
        settings = {
          ...applyPipelineSettings(settings, pipeline.settings),
          modeBEnabled: modeB.checked,
          modeBStrategy: strategy.success ? strategy.data : settings.modeBStrategy,
          devCaptureEnabled: devCapture.checked,
        };
        await saveSettings(settings);
        status.textContent = granted
          ? "Saved."
          : "Saved, but Mode B stays off: the browser did not grant its “alarms” permission.";
      } catch {
        status.textContent = "Could not save settings — check the values and try again.";
        return;
      }
      syncStatus.textContent = "";
      const synced = await syncSettings(settings, sendNativeOnce);
      syncStatus.textContent = describeSyncResult(synced);
    })();
  });
}

void init();
