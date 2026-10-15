import { join } from "node:path";
import type { Settings } from "@nmc/core";
import { loadSettings } from "@nmc/core/settings-file";
import { desktopDataDir } from "@nmc/native-host";

/**
 * Pipeline settings live in `%LOCALAPPDATA%\NoMoreClickbait\settings.json`,
 * written by the native host when the extension syncs its options
 * (`settings-sync`). Missing file → defaults; bad fields → their defaults.
 */

export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "settings.json");
}

export async function loadDesktopSettings(
  path: string = settingsFilePath(),
  log?: (line: string) => void,
): Promise<Settings> {
  const loaded = await loadSettings(path);
  if (loaded.warning) log?.(loaded.warning);
  return loaded.settings;
}
