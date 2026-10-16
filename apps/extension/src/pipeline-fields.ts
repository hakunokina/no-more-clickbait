import { settingCopy, SYNCED_SETTING_FIELDS, type SyncedSettings } from "@nmc/core";
import { t } from "./i18n.js";
import {
  SYNCED_SETTING_KEYS,
  VERIFY_DEPENDENT_KEYS,
  type PipelineFormInput,
  type PipelineFormResult,
} from "./pipeline-form.js";

/**
 * DOM side of the Options page's "Filter and verification" section:
 * renders the fields, fills them, reads them back and shows per-field
 * errors. Validation itself lives in pipeline-form.ts.
 */

export interface FieldControl {
  input: HTMLInputElement;
  error: HTMLElement;
  wrapper: HTMLElement;
}

export type PipelineControls = Map<string, FieldControl>;

/** Builds one labelled input per synced setting, straight from core's field table. */
export function renderPipelineFields(container: HTMLElement): PipelineControls {
  const doc = container.ownerDocument;
  const controls: PipelineControls = new Map();
  for (const key of SYNCED_SETTING_KEYS) {
    const field = SYNCED_SETTING_FIELDS[key];
    const copy = settingCopy(t("langCode") === "tr" ? "tr" : "en", key);
    const wrapper = doc.createElement("div");
    wrapper.className = "field";
    const label = doc.createElement("label");
    const input = doc.createElement("input");
    input.id = `setting-${key}`;
    input.name = key;
    if (field.kind === "boolean") {
      input.type = "checkbox";
      label.append(input, ` ${copy.label}`);
    } else {
      input.type = "number";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "1";
      input.inputMode = "numeric";
      input.required = true;
      label.append(`${copy.label} `, input);
    }
    const hint = doc.createElement("p");
    hint.id = `${input.id}-hint`;
    hint.className = "hint";
    hint.textContent =
      field.kind === "boolean"
        ? t(field.default ? "fieldDefaultOn" : "fieldDefaultOff", copy.description)
        : t("fieldRange", copy.description, field.min, field.max, field.default);
    const error = doc.createElement("p");
    error.id = `${input.id}-error`;
    error.className = "error";
    input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
    wrapper.append(label, hint, error);
    container.append(wrapper);
    controls.set(key, { input, error, wrapper });
  }
  return controls;
}

export function fillPipelineFields(controls: PipelineControls, values: SyncedSettings): void {
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

/** Disables the source-check fields while source checks are off. */
export function reflectVerifyEnabled(controls: PipelineControls): void {
  const verifyOn = controls.get("verifyEnabled")?.input.checked ?? true;
  for (const key of VERIFY_DEPENDENT_KEYS) {
    const control = controls.get(key);
    if (!control) continue;
    control.input.disabled = !verifyOn;
    control.wrapper.classList.toggle("off", !verifyOn);
    if (!verifyOn) {
      // Not validated while off, so an old error would only mislead.
      control.input.removeAttribute("aria-invalid");
      control.error.textContent = "";
    }
  }
}

export function readPipelineFields(controls: PipelineControls): PipelineFormInput {
  const input = {} as PipelineFormInput;
  for (const key of SYNCED_SETTING_KEYS) {
    const control = controls.get(key);
    const field = SYNCED_SETTING_FIELDS[key];
    input[key] =
      field.kind === "boolean" ? Boolean(control?.input.checked) : (control?.input.value ?? "");
  }
  return input;
}

/** Shows (or clears) each field's error and focuses the first invalid field. */
export function showPipelineErrors(
  controls: PipelineControls,
  result: PipelineFormResult,
): void {
  for (const key of SYNCED_SETTING_KEYS) {
    const control = controls.get(key);
    if (!control) continue;
    const message = result.ok ? undefined : result.errors[key];
    control.error.textContent = message ?? "";
    if (message) control.input.setAttribute("aria-invalid", "true");
    else control.input.removeAttribute("aria-invalid");
  }
  if (result.ok) return;
  const firstInvalid = SYNCED_SETTING_KEYS.find((key) => result.errors[key]);
  if (firstInvalid) controls.get(firstInvalid)?.input.focus();
}
