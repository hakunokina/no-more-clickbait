import {
  MANAGED_SETTING_FIELDS,
  ManagedSettingsSchema,
  settingCopy,
  type ManagedSettingKey,
  type ManagedSettings,
  type UiLang,
} from "@nmc/core";
import { messages, note, say, type DesktopMessages, type Note } from "../shared/i18n.js";

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

/** The form's sections in order, and the fields each one holds. */
export const SETTING_GROUPS = [
  {
    id: "sources",
    title: "groupSources",
    keys: ["collectFromX", "collectFromInstagram", "instagramFollowedOnly", "collectTarget"],
  },
  { id: "cut", title: "groupCut", keys: ["timelineSize", "maxClickbait", "minReadValue"] },
  {
    id: "checks",
    title: "groupChecks",
    keys: ["verifyEnabled", "minReadForVerify", "maxVerifications"],
  },
  { id: "modeB", title: "groupModeB", keys: ["modeBEnabled", "modeBPacing", "modeBStrategy"] },
  { id: "browser", title: "groupBrowser", keys: ["uiLanguage"] },
  { id: "developer", title: "groupDeveloper", keys: ["devCaptureEnabled"] },
] as const satisfies readonly {
  id: string;
  title: keyof DesktopMessages;
  keys: readonly ManagedSettingKey[];
}[];

export type SettingGroupId = (typeof SETTING_GROUPS)[number]["id"];

/**
 * Fields that only count while a switch is on: `disable` greys one out
 * and says why, `hide` keeps it out of sight. Its value stays either way
 * and is saved as it is, so it comes back as it was.
 */
export const SETTING_DEPENDS: Readonly<
  Partial<Record<ManagedSettingKey, { on: ManagedSettingKey; when: "disable" | "hide" }>>
> = {
  instagramFollowedOnly: { on: "collectFromInstagram", when: "disable" },
  modeBPacing: { on: "modeBEnabled", when: "hide" },
  modeBStrategy: { on: "modeBEnabled", when: "hide" },
};

/** Choices shown as a row of segments instead of a list. */
const SEGMENTED: ReadonlySet<ManagedSettingKey> = new Set(["modeBPacing", "uiLanguage"]);
/** Switches whose description is a warning while they are on. */
const RISKY: ReadonlySet<ManagedSettingKey> = new Set(["modeBEnabled"]);
/** Whole numbers up to this are a slider (they cannot go out of range). */
const SLIDER_MAX = 10;

// --- DOM (thin; exercised in the real window) --------------------------

export interface SettingsFormHandle {
  element: HTMLFormElement;
  read(base: ManagedSettings): SettingFormResult;
  fill(settings: ManagedSettings): void;
  showErrors(errors: Readonly<Record<string, Note>>): void;
  /** Re-words labels, hints, choices and shown errors; values stay. */
  setLanguage(lang: UiLang): void;
  /** Puts a control of the page's own (not saved with the form) at the top of a section. */
  insertField(group: SettingGroupId, field: HTMLElement): void;
}

interface FieldParts {
  wrap: HTMLElement;
  /** Carries the field's name, description and invalid state. */
  control: HTMLElement;
  /** What the user operates (disabled together). */
  inputs: (HTMLInputElement | HTMLSelectElement)[];
  label: HTMLElement;
  hint: HTMLElement;
  /** Why the field is greyed out (dependent fields only). */
  why: HTMLElement | null;
  error: HTMLElement;
  /** Each choice's visible label by value. */
  choices: Map<string, HTMLElement>;
  read(): string | boolean;
  write(value: string | boolean): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const made = doc.createElement(tag);
  if (className) made.className = className;
  return made;
}

/** A − or + beside a number field; pointer only (the field's arrow keys do the same). */
function stepButton(doc: Document, input: HTMLInputElement, step: number): HTMLButtonElement {
  const button = element(doc, "button");
  button.type = "button";
  button.tabIndex = -1;
  button.setAttribute("aria-hidden", "true");
  button.textContent = step < 0 ? "−" : "+";
  button.addEventListener("click", () => {
    const current = Number(input.value);
    const next = (Number.isFinite(current) ? current : 0) + step;
    input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return button;
}

function buildField(doc: Document, field: SettingFieldModel): FieldParts {
  const wrap = element(doc, "div", "f");
  const id = `setting-${field.key}`;
  const hint = element(doc, "p", "f__desc");
  hint.id = `${id}-hint`;
  const error = element(doc, "p", "f__err");
  error.id = `${id}-error`;
  const choices = new Map<string, HTMLElement>();
  let label: HTMLElement;
  let control: HTMLElement;
  let inputs: FieldParts["inputs"];
  let read: FieldParts["read"];
  let write: FieldParts["write"];

  if (field.kind === "choice" && SEGMENTED.has(field.key)) {
    label = element(doc, "span", "f__label f__full");
    label.id = `${id}-label`;
    control = element(doc, "span", "segc f__full");
    control.setAttribute("role", "radiogroup");
    control.setAttribute("aria-labelledby", label.id);
    const radios = field.options.map((option) => {
      const item = element(doc, "label");
      const radio = element(doc, "input");
      radio.type = "radio";
      radio.name = field.key;
      radio.value = option.value;
      const text = element(doc, "span");
      choices.set(option.value, text);
      item.append(radio, text);
      control.append(item);
      return radio;
    });
    inputs = radios;
    read = () => radios.find((radio) => radio.checked)?.value ?? "";
    write = (value) => {
      for (const radio of radios) radio.checked = radio.value === value;
    };
    wrap.append(label, control);
  } else {
    const labelFor = element(doc, "label");
    labelFor.htmlFor = id;
    label = labelFor;
    if (field.kind === "choice") {
      const select = element(doc, "select", "select f__full");
      for (const option of field.options) {
        const item = element(doc, "option");
        item.value = option.value;
        choices.set(option.value, item);
        select.append(item);
      }
      labelFor.className = "f__full";
      control = select;
      inputs = [select];
      read = () => select.value;
      write = (value) => (select.value = String(value));
      wrap.append(labelFor, select);
    } else if (field.kind === "boolean") {
      const box = element(doc, "input", "sw");
      box.type = "checkbox";
      box.setAttribute("role", "switch");
      control = box;
      inputs = [box];
      read = () => box.checked;
      write = (value) => (box.checked = value === true);
      wrap.append(labelFor, box);
    } else if (field.max <= SLIDER_MAX) {
      const range = element(doc, "input");
      range.type = "range";
      range.min = String(field.min);
      range.max = String(field.max);
      range.step = "1";
      // The badge repeats what the slider already says to a screen reader.
      const badge = element(doc, "span", "val");
      badge.setAttribute("aria-hidden", "true");
      const show = (): void => {
        badge.textContent = range.value;
      };
      range.addEventListener("input", show);
      const scale = element(doc, "div", "slider");
      const low = element(doc, "span");
      low.textContent = String(field.min);
      const high = element(doc, "span");
      high.textContent = String(field.max);
      scale.append(low, range, high);
      control = range;
      inputs = [range];
      read = () => range.value;
      write = (value) => {
        range.value = String(value);
        show();
      };
      wrap.append(labelFor, badge, scale);
    } else {
      const number = element(doc, "input");
      number.type = "number";
      number.min = String(field.min);
      number.max = String(field.max);
      number.step = "1";
      number.inputMode = "numeric";
      const step = field.max >= 1_000 ? 10 : 1;
      const box = element(doc, "span", "num");
      box.append(stepButton(doc, number, -step), number, stepButton(doc, number, step));
      control = number;
      inputs = [number];
      read = () => number.value;
      write = (value) => (number.value = String(value));
      wrap.append(labelFor, box);
    }
  }
  control.id = id;
  for (const input of inputs) input.name = field.key;

  let why: HTMLElement | null = null;
  const describedBy = [hint.id, error.id];
  if (SETTING_DEPENDS[field.key]?.when === "disable") {
    why = element(doc, "p", "f__why");
    why.id = `${id}-why`;
    describedBy.push(why.id);
    wrap.classList.add("f--sub");
  }
  control.setAttribute("aria-describedby", describedBy.join(" "));
  wrap.append(hint, ...(why ? [why] : []), error);
  return { wrap, control, inputs, label, hint, why, error, choices, read, write };
}

/**
 * Builds the form into `container`: a section per group, one labelled
 * control per field with the core description as its hint and an error
 * line wired with aria-describedby. Submit is left to the caller.
 */
export function buildSettingsForm(
  container: HTMLElement,
  lang: UiLang = "en",
  doc: Document = container.ownerDocument,
): SettingsFormHandle {
  const form = doc.createElement("form");
  form.noValidate = true;
  const fields = new Map<ManagedSettingKey, FieldParts>();
  const sections = new Map<SettingGroupId, { section: HTMLElement; heading: HTMLElement }>();
  let shownLang = lang;
  let shownErrors: Readonly<Record<string, Note>> = {};

  for (const group of SETTING_GROUPS) {
    const section = element(doc, "section", "sec");
    const heading = element(doc, "h2");
    heading.id = `group-${group.id}`;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    form.append(section);
    sections.set(group.id, { section, heading });
  }
  const models = settingFieldModels(lang);
  const placed = new Set<ManagedSettingKey>(SETTING_GROUPS.flatMap((group) => group.keys));
  const last = SETTING_GROUPS[SETTING_GROUPS.length - 1]!;
  for (const group of SETTING_GROUPS) {
    // A field core adds before it is placed here still shows, at the end.
    const keys: readonly ManagedSettingKey[] =
      group === last
        ? [...group.keys, ...models.map((m) => m.key).filter((key) => !placed.has(key))]
        : group.keys;
    for (const key of keys) {
      const model = models.find((m) => m.key === key);
      if (!model) continue;
      const parts = buildField(doc, model);
      sections.get(group.id)!.section.append(parts.wrap);
      fields.set(key, parts);
    }
  }
  container.append(form);

  /** Shows each dependent field as its switch says; values are never touched. */
  function follow(): void {
    for (const [key, rule] of Object.entries(SETTING_DEPENDS) as [
      ManagedSettingKey,
      { on: ManagedSettingKey; when: "disable" | "hide" },
    ][]) {
      const parts = fields.get(key);
      const on = fields.get(rule.on)?.read() === true;
      if (!parts) continue;
      if (rule.when === "hide") {
        parts.wrap.hidden = !on;
      } else {
        for (const input of parts.inputs) input.disabled = !on;
        parts.wrap.classList.toggle("f--off", !on);
        if (parts.why) parts.why.hidden = on;
      }
    }
    for (const key of RISKY) {
      const parts = fields.get(key);
      parts?.hint.classList.toggle("call", parts.read() === true);
      parts?.hint.classList.toggle("call--warn", parts.read() === true);
    }
  }
  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") follow();
  });

  function word(): void {
    const m = messages(shownLang);
    for (const group of SETTING_GROUPS)
      sections.get(group.id)!.heading.textContent = m[group.title];
    for (const field of settingFieldModels(shownLang)) {
      const parts = fields.get(field.key)!;
      parts.label.textContent = field.label;
      parts.hint.textContent = field.description;
      if (field.kind === "choice") {
        for (const option of field.options) {
          const shown = parts.choices.get(option.value);
          if (shown) shown.textContent = option.label;
        }
      }
      const rule = SETTING_DEPENDS[field.key];
      if (parts.why && rule)
        parts.why.textContent = m.appliesWhenOn(settingCopy(shownLang, rule.on).label);
    }
    for (const [key, parts] of fields) {
      const error = shownErrors[key];
      parts.error.textContent = error ? say(shownLang, error) : "";
    }
  }
  word();
  follow();

  return {
    element: form,
    read(base) {
      const values: Record<string, string | boolean> = {};
      for (const [key, parts] of fields) values[key] = parts.read();
      return readSettingForm(values, base);
    },
    fill(settings) {
      const values = settingFormValues(settings);
      shownErrors = {};
      for (const [key, parts] of fields) {
        parts.write(values[key] ?? "");
        parts.control.removeAttribute("aria-invalid");
        parts.error.textContent = "";
      }
      follow();
    },
    showErrors(errors) {
      shownErrors = errors;
      word();
      // No focus move: errors show while the user types, saved as they go.
      for (const [key, { control }] of fields) {
        if (errors[key]) control.setAttribute("aria-invalid", "true");
        else control.removeAttribute("aria-invalid");
      }
    },
    setLanguage(next) {
      if (next === shownLang) return;
      shownLang = next;
      word();
    },
    insertField(group, field) {
      sections.get(group)!.heading.after(field);
    },
  };
}
