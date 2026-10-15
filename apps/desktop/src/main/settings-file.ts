import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopDataDir } from "@nmc/native-host";

/**
 * Pipeline settings, read from `%LOCALAPPDATA%\NoMoreClickbait\settings.json`
 * (written by the native host when the extension options change).
 * Scores are on the 0-10 scale the user sees.
 *
 * TEMPORARY: core's `loadSettings` / Settings fields for these knobs are
 * landing separately (#1935); until then the file is read leniently here
 * and every missing or invalid field falls back to the owner's defaults.
 */

export interface PipelineSettings {
  /** Distinct posts a collection gathers before the run starts (Mode A and B). */
  collectTarget: number;
  timelineSize: number;
  /** Posts at or above this clickbait score (0-10) are dropped. */
  maxClickbait: number;
  /** Read-value floor (0-10). */
  minReadValue: number;
  /** Read value (0-10) a check-worthy post needs to be verified. */
  minReadForVerify: number;
  maxVerifications: number;
  verifyEnabled: boolean;
}

export const PIPELINE_DEFAULTS: PipelineSettings = {
  collectTarget: 250,
  timelineSize: 50,
  maxClickbait: 7,
  minReadValue: 2,
  minReadForVerify: 4,
  maxVerifications: 20,
  verifyEnabled: true,
};

const RANGES: Record<Exclude<keyof PipelineSettings, "verifyEnabled">, [number, number]> = {
  collectTarget: [1, 10_000],
  timelineSize: [1, 100],
  maxClickbait: [1, 11],
  minReadValue: [0, 10],
  minReadForVerify: [0, 10],
  maxVerifications: [0, 100],
};

export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "settings.json");
}

export function parsePipelineSettings(raw: unknown): PipelineSettings {
  const source =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const settings: PipelineSettings = { ...PIPELINE_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
      settings[key] = value;
    }
  }
  // Older settings files only know modeBTarget.
  if (source["collectTarget"] === undefined) {
    const legacy = source["modeBTarget"];
    if (typeof legacy === "number" && Number.isInteger(legacy) && legacy >= 1 && legacy <= 10_000) {
      settings.collectTarget = legacy;
    }
  }
  if (typeof source["verifyEnabled"] === "boolean") settings.verifyEnabled = source["verifyEnabled"];
  return settings;
}

export async function loadPipelineSettings(path: string = settingsFilePath()): Promise<PipelineSettings> {
  try {
    return parsePipelineSettings(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return { ...PIPELINE_DEFAULTS };
  }
}
