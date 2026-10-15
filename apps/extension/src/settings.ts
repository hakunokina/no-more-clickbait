import { SettingsSchema, type Settings } from "@nmc/core";
import { SETTINGS_STORAGE_KEY } from "./settings-key.js";

export { SETTINGS_STORAGE_KEY };

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const parsed = SettingsSchema.safeParse(stored[SETTINGS_STORAGE_KEY] ?? {});
  // Mode B must NEVER silently turn on: any doubt resolves to defaults,
  // and the defaults have modeBEnabled = false.
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: SettingsSchema.parse(settings) });
}
