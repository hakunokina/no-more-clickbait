import {
  SettingsFieldsSchema,
  SettingsSchema,
  SYNCED_SETTING_FIELDS,
  SyncedSettingsSchema,
  type Settings,
  type SyncedSettingKey,
  type SyncedSettings,
} from "@nmc/core";

/**
 * Form logic of the Options page's "Filter and verification" section.
 * Fields, bounds, defaults and copy all come from core's
 * SYNCED_SETTING_FIELDS, so the form cannot drift from the schema the
 * desktop validates against. DOM-free so it can be unit tested.
 */

export const SYNCED_SETTING_KEYS = Object.keys(SYNCED_SETTING_FIELDS) as SyncedSettingKey[];

/** Settings that only matter while source checks (`verifyEnabled`) are on. */
export const VERIFY_DEPENDENT_KEYS: ReadonlySet<SyncedSettingKey> = new Set([
  "minReadForVerify",
  "maxVerifications",
]);

/** Raw form values: number inputs give strings, checkboxes booleans. */
export type PipelineFormInput = Record<SyncedSettingKey, string | boolean>;

export type PipelineFormResult =
  | { ok: true; settings: SyncedSettings }
  | { ok: false; errors: Partial<Record<SyncedSettingKey, string>> };

export function defaultSyncedSettings(): SyncedSettings {
  return SyncedSettingsSchema.parse({});
}

const MODE_B_TARGET_MAX =
  SettingsFieldsSchema.shape.modeBTarget.removeDefault().maxValue ?? 1_000;

/**
 * Applies validated form values to the stored settings. `collectTarget`
 * is the one collection target users see; the deprecated `modeBTarget`
 * mirrors it (within its own bound) so readers not yet moved to
 * `collectTarget` see the same number instead of a frozen old one.
 */
export function applyPipelineSettings(settings: Settings, synced: SyncedSettings): Settings {
  return SettingsSchema.parse({
    ...settings,
    ...synced,
    modeBTarget: Math.min(synced.collectTarget, MODE_B_TARGET_MAX),
  });
}

/**
 * Validates the form. Out-of-range or non-integer values are reported
 * per field — never silently clamped — so the user sees what was not
 * accepted. While source checks are off, their (disabled) fields are not
 * validated: an invalid value there keeps the `stored` one instead of
 * blocking the save.
 */
export function readPipelineForm(
  input: PipelineFormInput,
  stored: SyncedSettings = defaultSyncedSettings(),
): PipelineFormResult {
  const verifyOn = input["verifyEnabled"] === true;
  const values: Record<string, number | boolean> = {};
  const errors: Partial<Record<SyncedSettingKey, string>> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const field = SYNCED_SETTING_FIELDS[key];
    const raw = input[key];
    if (field.kind === "boolean") {
      values[key] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    const value = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      if (!verifyOn && VERIFY_DEPENDENT_KEYS.has(key)) {
        values[key] = stored[key];
        continue;
      }
      errors[key] = `Enter a whole number from ${field.min} to ${field.max}.`;
      continue;
    }
    values[key] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, settings: SyncedSettingsSchema.parse(values) };
}
