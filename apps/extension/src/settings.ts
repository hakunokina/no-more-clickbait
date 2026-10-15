import { SettingsSchema, type Settings } from "@nmc/core";

const STORAGE_KEY = "nmc-settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const parsed = SettingsSchema.safeParse(stored[STORAGE_KEY] ?? {});
  // Mode B must NEVER silently turn on: any doubt resolves to defaults,
  // and the defaults have modeBEnabled = false.
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: SettingsSchema.parse(settings) });
}
