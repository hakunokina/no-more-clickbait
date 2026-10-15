import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SyncedSettingsSchema, type SyncedSettings } from "@nmc/core";

/**
 * Where the desktop pipeline reads the user's settings:
 * `%LOCALAPPDATA%\NoMoreClickbait\settings.json` (next to the host
 * manifest install-host.ps1 writes). Read it with
 * `@nmc/core/settings-file`'s `loadSettings`.
 */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env["LOCALAPPDATA"];
  return localAppData
    ? join(localAppData, "NoMoreClickbait", "settings.json")
    : join(homedir(), ".local", "share", "NoMoreClickbait", "settings.json");
}

/**
 * On Windows a rename over a file another process has open (the desktop
 * reading it) fails briefly with EPERM/EACCES/EBUSY; retry a few times.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Saves the synced settings atomically: written to a temp file in the
 * same folder, then renamed over the target, so a reader never sees a
 * half-written file. UTF-8 without BOM. Only the validated synced
 * fields are written — the file belongs to the extension's sync.
 */
export async function saveSyncedSettings(
  settings: SyncedSettings,
  path: string = defaultSettingsPath(),
): Promise<void> {
  const valid = SyncedSettingsSchema.parse(settings);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
