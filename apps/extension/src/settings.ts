import {
  SettingsSchema,
  SettingsStampSchema,
  UNSTAMPED,
  type Settings,
  type SettingsStamp,
} from "@nmc/core";

export const SETTINGS_STORAGE_KEY = "nmc-settings";
/** When and where the settings were last saved (Options page or desktop app). */
export const SETTINGS_STAMP_KEY = "nmc-settings-stamp";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const parsed = SettingsSchema.safeParse(stored[SETTINGS_STORAGE_KEY] ?? {});
  // Mode B must NEVER silently turn on: any doubt resolves to defaults,
  // and the defaults have modeBEnabled = false.
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

/** Settings saved before stamps existed count as older than any stamped save. */
export async function loadSettingsStamp(): Promise<SettingsStamp> {
  const stored = await chrome.storage.local.get(SETTINGS_STAMP_KEY);
  const parsed = SettingsStampSchema.safeParse(stored[SETTINGS_STAMP_KEY]);
  return parsed.success ? parsed.data : UNSTAMPED;
}

/** Saves the settings, and their stamp when given, in one storage write. */
export async function saveSettings(settings: Settings, stamp?: SettingsStamp): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: SettingsSchema.parse(settings),
    ...(stamp ? { [SETTINGS_STAMP_KEY]: SettingsStampSchema.parse(stamp) } : {}),
  });
}
