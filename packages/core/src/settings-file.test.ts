import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SettingsSchema } from "./schemas.js";
import { loadSettings } from "./settings-file.js";

describe("loadSettings", () => {
  let dir: string;
  const defaults = SettingsSchema.parse({});

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-settings-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, content: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content, "utf8");
    return path;
  }

  it("returns defaults without a warning when the file does not exist", async () => {
    expect(await loadSettings(join(dir, "missing.json"))).toEqual({
      settings: defaults,
      found: false,
    });
  });

  it("reads a valid file (BOM tolerated), filling fields it lacks", async () => {
    const path = await file("ok.json", '\uFEFF{"maxClickbait": 5, "verifyEnabled": false}');
    expect(await loadSettings(path)).toEqual({
      settings: { ...defaults, maxClickbait: 5, verifyEnabled: false },
      found: true,
    });
  });

  it("resets only the invalid fields and says which", async () => {
    const path = await file(
      "partial.json",
      JSON.stringify({ maxClickbait: 99, minReadForVerify: 6, modeBEnabled: "yes", extra: 1 }),
    );
    const loaded = await loadSettings(path);
    expect(loaded.settings).toEqual({ ...defaults, minReadForVerify: 6 });
    expect(loaded.settings.modeBEnabled).toBe(false);
    expect(loaded.warning).toMatch(/maxClickbait/);
    expect(loaded.warning).toMatch(/modeBEnabled/);
  });

  it.each([
    ["not JSON", "{oops", /not JSON/],
    ["an array", "[1,2]", /not a JSON object/],
    ["null", "null", /not a JSON object/],
  ])(
    "falls back to defaults with a warning when the file is %s",
    async (_, content, warning) => {
      const loaded = await loadSettings(await file(`bad-${content.length}.json`, content));
      expect(loaded.settings).toEqual(defaults);
      expect(loaded.found).toBe(true);
      expect(loaded.warning).toMatch(warning);
    },
  );

  it("falls back to defaults with a warning when the path is unreadable", async () => {
    const loaded = await loadSettings(dir);
    expect(loaded).toMatchObject({ settings: defaults, found: true });
    expect(loaded.warning).toMatch(/unreadable/);
  });
});
