import {
  EXTENSION_SETTING_FIELDS,
  ManagedSettingsSchema,
  SYNCED_SETTING_FIELDS,
  type ManagedSettings,
} from "@nmc/core";

/**
 * The desktop Settings form: fields, bounds and copy come straight from
 * core (the same tables the extension's Options page renders), so the
 * two forms cannot drift apart. This module is the pure model plus a
 * thin DOM builder; wiring it into the monitor window (preload IPC,
 * status field) is a separate step.
 */

export type SettingFieldModel =
  | {
      key: string;
      kind: "integer";
      min: number;
      max: number;
      label: string;
      description: string;
    }
  | { key: string; kind: "boolean"; label: string; description: string }
  | {
      key: string;
      kind: "choice";
      options: readonly { value: string; label: string }[];
      label: string;
      description: string;
    };

function toModel(key: string, field: unknown): SettingFieldModel {
  const f = field as {
    kind: string;
    min?: number;
    max?: number;
    options?: readonly { value: string; label: string }[];
    label: string;
    description: string;
  };
  if (f.kind === "integer") {
    return {
      key,
      kind: "integer",
      min: f.min!,
      max: f.max!,
      label: f.label,
      description: f.description,
    };
  }
  if (f.kind === "choice") {
    return {
      key,
      kind: "choice",
      options: f.options!,
      label: f.label,
      description: f.description,
    };
  }
  return { key, kind: "boolean", label: f.label, description: f.description };
}

/** Pipeline + collection fields, in core's table order. */
export function settingFieldModels(): SettingFieldModel[] {
  return [
    ...Object.entries(SYNCED_SETTING_FIELDS),
    ...Object.entries(EXTENSION_SETTING_FIELDS),
  ].map(([key, field]) => toModel(key, field));
}

/** Raw form values keyed by setting (text for integers/choices, checkbox booleans). */
export type SettingFormValues = Readonly<Record<string, string | boolean>>;

export type SettingFormResult =
  | { ok: true; settings: ManagedSettings }
  | { ok: false; errors: Readonly<Record<string, string>> };

/**
 * Validates raw form values against core's bounds. Every bad field gets
 * its own message (the form is `novalidate`; native bubbles would hide
 * these). Unknown keys are ignored, missing ones read as invalid.
 */
export function parseSettingForm(values: SettingFormValues): SettingFormResult {
  const errors: Record<string, string> = {};
  const parsed: Record<string, unknown> = {};
  for (const field of settingFieldModels()) {
    const raw = values[field.key];
    if (field.kind === "boolean") {
      parsed[field.key] = raw === true;
    } else if (field.kind === "choice") {
      if (typeof raw === "string" && field.options.some((option) => option.value === raw)) {
        parsed[field.key] = raw;
      } else {
        errors[field.key] = "Pick one of the listed options.";
      }
    } else {
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isInteger(number) || number < field.min || number > field.max) {
        errors[field.key] = `Enter a whole number between ${field.min} and ${field.max}.`;
      } else {
        parsed[field.key] = number;
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const settings = ManagedSettingsSchema.safeParse(parsed);
  return settings.success
    ? { ok: true, settings: settings.data }
    : { ok: false, errors: { form: "Some values are out of range." } };
}

/** The raw values that fill the form from a settings object. */
export function settingFormValues(settings: ManagedSettings): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of settingFieldModels()) {
    const value = settings[field.key as keyof ManagedSettings];
    values[field.key] = typeof value === "boolean" ? value : String(value);
  }
  return values;
}

// --- DOM (thin; exercised in the real window) --------------------------

export interface SettingsFormHandle {
  element: HTMLFormElement;
  read(): SettingFormResult;
  fill(settings: ManagedSettings): void;
  showErrors(errors: Readonly<Record<string, string>>): void;
}

/**
 * Builds the form into `container`: one labelled control per field,
 * the core description as its hint, an error line wired with
 * aria-describedby. Submit is left to the caller.
 */
export function buildSettingsForm(
  container: HTMLElement,
  doc: Document = container.ownerDocument,
): SettingsFormHandle {
  const form = doc.createElement("form");
  form.noValidate = true;
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const errorLines = new Map<string, HTMLElement>();

  for (const field of settingFieldModels()) {
    const wrap = doc.createElement("div");
    wrap.className = "setting-field";
    const inputId = `setting-${field.key}`;
    const label = doc.createElement("label");
    label.htmlFor = inputId;
    label.textContent = field.label;

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "choice") {
      input = doc.createElement("select");
      for (const option of field.options) {
        const el = doc.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
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
    hint.textContent = field.description;

    const errorId = `${inputId}-error`;
    const error = doc.createElement("p");
    error.id = errorId;
    error.className = "error";

    input.setAttribute("aria-describedby", `${hintId} ${errorId}`);
    wrap.append(label, input, hint, error);
    form.append(wrap);
    inputs.set(field.key, input);
    errorLines.set(field.key, error);
  }
  container.append(form);

  return {
    element: form,
    read() {
      const values: Record<string, string | boolean> = {};
      for (const [key, input] of inputs) {
        values[key] =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : input.value;
      }
      return parseSettingForm(values);
    },
    fill(settings) {
      const values = settingFormValues(settings);
      for (const [key, input] of inputs) {
        const value = values[key];
        if (input instanceof HTMLInputElement && input.type === "checkbox") {
          input.checked = value === true;
        } else {
          input.value = String(value ?? "");
        }
        input.removeAttribute("aria-invalid");
        errorLines.get(key)!.textContent = "";
      }
    },
    showErrors(errors) {
      for (const [key, input] of inputs) {
        const message = errors[key] ?? "";
        errorLines.get(key)!.textContent = message;
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
      const first = Object.keys(errors)[0];
      if (first) inputs.get(first)?.focus();
    },
  };
}
