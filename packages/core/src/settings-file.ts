import { readFile } from "node:fs/promises";
import { SettingsSchema, SettingsStampSchema, type Settings, type SettingsStamp } from "./schemas.js";

/**
 * Reads user settings from a JSON file on the desktop side (Node only;
 * the browser extension keeps its own copy in chrome.storage). Never
 * throws on bad content: a broken file must not stop a run, so every
 * problem resolves to defaults and is reported as a warning.
 *
 * Fields are checked one by one: an out-of-range or mistyped field
 * falls back to its default while the valid ones are kept. Unknown
 * keys are ignored. (Mode B therefore never turns on from a corrupt
 * value — its default is off.)
 */

export interface LoadedSettings {
  settings: Settings;
  /** False when the file does not exist (first run): defaults, no warning. */
  found: boolean;
  /** Set when the file was unreadable, not JSON, or had invalid fields. */
  warning?: string;
  /** When and where the settings were saved; absent in files written before stamps. */
  stamp?: SettingsStamp;
}

const DEFAULTS = (): Settings => SettingsSchema.parse({});

export async function loadSettings(path: string): Promise<LoadedSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: DEFAULTS(), found: false };
    }
    return {
      settings: DEFAULTS(),
      found: true,
      warning: `settings file unreadable, using defaults: ${String(error)}`,
    };
  }
  let json: unknown;
  try {
    // A UTF-8 BOM (some Windows editors add one) is not JSON.
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return {
      settings: DEFAULTS(),
      found: true,
      warning: "settings file is not JSON, using defaults",
    };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      settings: DEFAULTS(),
      found: true,
      warning: "settings file is not a JSON object, using defaults",
    };
  }
  const candidate: Record<string, unknown> = { ...json };
  const stampParsed = SettingsStampSchema.safeParse({
    updatedAt: candidate["updatedAt"],
    source: candidate["source"],
  });
  const stamp = stampParsed.success ? { stamp: stampParsed.data } : {};
  const parsed = SettingsSchema.safeParse(candidate);
  if (parsed.success) return { settings: parsed.data, found: true, ...stamp };

  const invalid = [
    ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "(root)"))),
  ];
  for (const key of invalid) delete candidate[key];
  const repaired = SettingsSchema.safeParse(candidate);
  return {
    settings: repaired.success ? repaired.data : DEFAULTS(),
    found: true,
    ...stamp,
    warning: `invalid settings reset to defaults: ${invalid.join(", ")}`,
  };
}
