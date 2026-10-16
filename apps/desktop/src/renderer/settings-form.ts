import {
  MANAGED_SETTING_FIELDS,
  ManagedSettingsSchema,
  settingCopy,
  type ManagedSettingKey,
  type ManagedSettings,
  type UiLang,
} from "@nmc/core";
import { note, say, type Note } from "../shared/i18n.js";

/**
 * The desktop Settings form: fields and bounds come straight from core
 * (the same tables the extension's Options page renders), and so does
 * their copy in both languages (settingCopy), so the two forms cannot
 * drift apart. This module is the pure model plus a thin DOM builder.
 */

export type SettingFieldModel =
  | {
      key: ManagedSettingKey;
      kind: "integer";
      min: number;
      max: number;
      label: string;
      description: string;
    }
  | { key: ManagedSettingKey; kind: "boolean"; label: string; description: string }
  | {
      key: ManagedSettingKey;
      kind: "choice";
      options: readonly { value: string; label: string }[];
      label: string;
      description: string;
    };

function toModel(key: ManagedSettingKey, lang: UiLang): SettingFieldModel {
  const field = MANAGED_SETTING_FIELDS[key];
  const { label, description, options } = settingCopy(lang, key);
  if (field.kind === "integer") {
    return { key, kind: "integer", min: field.min, max: field.max, label, description };
  }
  if (field.kind === "choice") {
    return {
      key,
      kind: "choice",
      options: field.options.map(({ value }: { value: string }) => ({
        value,
        label: options?.[value] ?? value,
      })),
      label,
      description,
    };
  }
  return { key, kind: "boolean", label, description };
}

/** Pipeline, collection and UI fields, in core's table order, worded in `lang`. */
export function settingFieldModels(lang: UiLang = "en"): SettingFieldModel[] {
  return (Object.keys(MANAGED_SETTING_FIELDS) as ManagedSettingKey[]).map((key) =>
    toModel(key, lang),
  );
}

/** Raw form values keyed by setting (text for integers/choices, checkbox booleans). */
export type SettingFormValues = Readonly<Record<string, string | boolean>>;

/**
 * The settings to save — every valid field's value over `base` — and
 * the fields that do not validate (they keep their `base` value). Errors
 * are notes: the form words them in whatever language it shows.
 */
export interface SettingFormResult {
  settings: ManagedSettings;
  errors: Readonly<Record<string, Note>>;
}

/**
 * Validates raw form values against core's bounds. Every bad field gets
 * its own message (the form is `novalidate`; native bubbles would hide
 * these) and is left at its `base` value, so the valid ones can still be
 * saved. Unknown keys are ignored, missing ones read as invalid.
 */
export function readSettingForm(
  values: SettingFormValues,
  base: ManagedSettings,
): SettingFormResult {
  const errors: Record<string, Note> = {};
  const parsed: Record<string, unknown> = { ...base };
  for (const field of settingFieldModels()) {
    const raw = values[field.key];
    if (field.kind === "boolean") {
      parsed[field.key] = raw === true;
    } else if (field.kind === "choice") {
      if (typeof raw === "string" && field.options.some((option) => option.value === raw)) {
        parsed[field.key] = raw;
      } else {
        errors[field.key] = note("pickOption");
      }
    } else {
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isInteger(number) || number < field.min || number > field.max) {
        errors[field.key] = note("wholeNumber", field.min, field.max);
      } else {
        parsed[field.key] = number;
      }
    }
  }
  const settings = ManagedSettingsSchema.safeParse(parsed);
  return settings.success
    ? { settings: settings.data, errors }
    : { settings: base, errors: { ...errors, form: note("outOfRange") } };
}

/** The raw values that fill the form from a settings object. */
export function settingFormValues(settings: ManagedSettings): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of settingFieldModels()) {
    const value = settings[field.key];
    values[field.key] = typeof value === "boolean" ? value : String(value);
  }
  return values;
}

// --- DOM (thin; exercised in the real window) --------------------------

export interface SettingsFormHandle {
  element: HTMLFormElement;
  read(base: ManagedSettings): SettingFormResult;
  fill(settings: ManagedSettings): void;
  showErrors(errors: Readonly<Record<string, Note>>): void;
  /** Re-words labels, hints, choices and shown errors; values stay. */
  setLanguage(lang: UiLang): void;
}

interface FieldParts {
  input: HTMLInputElement | HTMLSelectElement;
  label: HTMLLabelElement;
  hint: HTMLElement;
  error: HTMLElement;
}

/**
 * Builds the form into `container`: one labelled control per field,
 * the core description as its hint, an error line wired with
 * aria-describedby. Submit is left to the caller.
 */
export function buildSettingsForm(
  container: HTMLElement,
  lang: UiLang = "en",
  doc: Document = container.ownerDocument,
): SettingsFormHandle {
  const form = doc.createElement("form");
  form.noValidate = true;
  const fields = new Map<string, FieldParts>();
  let shownLang = lang;
  let shownErrors: Readonly<Record<string, Note>> = {};

  for (const field of settingFieldModels(lang)) {
    const wrap = doc.createElement("div");
    wrap.className = "setting-field";
    const inputId = `setting-${field.key}`;
    const label = doc.createElement("label");
    label.htmlFor = inputId;

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "choice") {
      input = doc.createElement("select");
      for (const option of field.options) {
        const el = doc.createElement("option");
        el.value = option.value;
        input.append(el);
      }
    } else {
      input = doc.createElement("input");
      input.type = field.kind === "boolean" ? "checkbox" : "number";
      if (field.kind === "integer") {
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = "1";
        input.inputMode = "numeric";
      }
    }
    input.id = inputId;
    input.name = field.key;

    const hintId = `${inputId}-hint`;
    const hint = doc.createElement("p");
    hint.id = hintId;
    hint.className = "hint";

    const errorId = `${inputId}-error`;
    const error = doc.createElement("p");
    error.id = errorId;
    error.className = "error";

    input.setAttribute("aria-describedby", `${hintId} ${errorId}`);
    wrap.append(label, input, hint, error);
    form.append(wrap);
    fields.set(field.key, { input, label, hint, error });
  }
  container.append(form);

  function word(): void {
    for (const field of settingFieldModels(shownLang)) {
      const parts = fields.get(field.key)!;
      parts.label.textContent = field.label;
      parts.hint.textContent = field.description;
      if (field.kind === "choice" && parts.input instanceof HTMLSelectElement) {
        for (const option of parts.input.options) {
          option.textContent =
            field.options.find((choice) => choice.value === option.value)?.label ??
            option.value;
        }
      }
    }
    for (const [key, parts] of fields) {
      const error = shownErrors[key];
      parts.error.textContent = error ? say(shownLang, error) : "";
    }
  }
  word();

  return {
    element: form,
    read(base) {
      const values: Record<string, string | boolean> = {};
      for (const [key, { input }] of fields) {
        values[key] =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : input.value;
      }
      return readSettingForm(values, base);
    },
    fill(settings) {
      const values = settingFormValues(settings);
      shownErrors = {};
      for (const [key, { input, error }] of fields) {
        const value = values[key];
        if (input instanceof HTMLInputElement && input.type === "checkbox") {
          input.checked = value === true;
        } else {
          input.value = String(value ?? "");
        }
        input.removeAttribute("aria-invalid");
        error.textContent = "";
      }
    },
    showErrors(errors) {
      shownErrors = errors;
      word();
      // No focus move: errors show while the user types, saved as they go.
      for (const [key, { input }] of fields) {
        if (errors[key]) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    },
    setLanguage(next) {
      if (next === shownLang) return;
      shownLang = next;
      word();
    },
  };
}
