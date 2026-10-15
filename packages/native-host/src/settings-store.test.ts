import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSettingsSchema, type ManagedSettings, type SettingsStamp } from "@nmc/core";
import { loadSettings } from "@nmc/core/settings-file";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";
import { defaultSettingsPath, saveSettingsFile } from "./settings-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nmc-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const synced: ManagedSettings = ManagedSettingsSchema.parse({
  maxClickbait: 5,
  timelineSize: 30,
});

const stampAt = (updatedAt: string, source: SettingsStamp["source"] = "extension") => ({
  updatedAt,
  source,
});

describe("defaultSettingsPath", () => {
  it("lives under %LOCALAPPDATA%\\NoMoreClickbait", () => {
    expect(defaultSettingsPath({ LOCALAPPDATA: "C:\\App" })).toBe(
      join("C:\\App", "NoMoreClickbait", "settings.json"),
    );
  });
});

describe("saveSettingsFile", () => {
  it("writes BOM-less JSON the desktop's loadSettings reads back", async () => {
    const path = join(dir, "nested", "settings.json");
    await saveSettingsFile(synced, undefined, path);
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(synced);
    const loaded = await loadSettings(path);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.settings).toMatchObject(synced);
  });

  it("replaces the previous file and leaves no temp file behind", async () => {
    const path = join(dir, "settings.json");
    await saveSettingsFile(synced, undefined, path);
    await saveSettingsFile({ ...synced, maxClickbait: 9 }, undefined, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ maxClickbait: 9 });
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("refuses invalid settings without touching the file", async () => {
    const path = join(dir, "settings.json");
    await saveSettingsFile(synced, undefined, path);
    await expect(
      saveSettingsFile({ ...synced, timelineSize: 0 }, undefined, path),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(synced);
  });

  it("saves the stamp and keeps a later save (last writer wins)", async () => {
    const path = join(dir, "settings.json");
    const desktop = stampAt("2026-10-15T10:00:00.000Z", "desktop");
    await expect(saveSettingsFile(synced, desktop, path)).resolves.toEqual({
      written: true,
      settings: synced,
      stamp: desktop,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...synced, ...desktop });
    expect((await loadSettings(path)).stamp).toEqual(desktop);

    // An older save (or an unstamped one from an older extension) loses.
    for (const older of [stampAt("2026-10-15T09:59:59.000Z"), undefined]) {
      await expect(
        saveSettingsFile({ ...synced, maxClickbait: 9 }, older, path),
      ).resolves.toEqual({ written: false, settings: synced, stamp: desktop });
    }
    // The same moment or later wins.
    const later = stampAt("2026-10-15T10:00:01.000Z");
    await expect(
      saveSettingsFile({ ...synced, maxClickbait: 2 }, later, path),
    ).resolves.toMatchObject({ written: true, stamp: later });
    expect((await loadSettings(path)).settings.maxClickbait).toBe(2);
  });
});

describe("settings-sync over the bridge", () => {
  it("decodes a framed settings-sync, saves it and acks settings-synced", async () => {
    const path = join(dir, "settings.json");
    const [raw] = new MessageDecoder().push(
      encodeMessage({ type: "settings-sync", settings: synced }),
    );
    const reply = await handleBridgeMessage(raw ?? "", {
      onPostBatch: () => {},
      onSettingsSync: async (settings, stamp) => {
        await saveSettingsFile(settings, stamp, path);
      },
    });
    expect(reply).toEqual({ type: "settings-synced" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(synced);
  });

  it("rejects invalid settings and never calls the store", async () => {
    let calls = 0;
    const handlers = {
      onPostBatch: () => {},
      onSettingsSync: () => {
        calls += 1;
      },
    };
    for (const settings of [
      { ...synced, maxClickbait: 11 },
      { ...synced, verifyEnabled: "yes" },
      { ...synced, collectTarget: 2.5 },
      "not an object",
    ]) {
      await expect(
        handleBridgeMessage(JSON.stringify({ type: "settings-sync", settings }), handlers),
      ).resolves.toMatchObject({ type: "error" });
    }
    expect(calls).toBe(0);
  });

  it("drops unknown keys so only the managed settings reach the file", async () => {
    let received: unknown;
    await handleBridgeMessage(
      JSON.stringify({
        type: "settings-sync",
        settings: { ...synced, captureTarget: 40, bodyText: "a post" },
      }),
      {
        onPostBatch: () => {},
        onSettingsSync: (settings) => {
          received = settings;
        },
      },
    );
    expect(received).toEqual(synced);
  });

  it("answers with an error when the host has no settings store", async () => {
    await expect(
      handleBridgeMessage(JSON.stringify({ type: "settings-sync", settings: synced }), {
        onPostBatch: () => {},
      }),
    ).resolves.toEqual({
      type: "error",
      message: "settings sync is not configured on this host",
    });
  });
});

describe("settings-push-result over the bridge", () => {
  it("hands the extension's answer to the store and acks it", async () => {
    const stamp = stampAt("2026-10-15T10:00:00.000Z", "desktop");
    let received: unknown;
    const reply = await handleBridgeMessage(
      JSON.stringify({
        type: "settings-push-result",
        outcome: "applied",
        settings: synced,
        stamp,
        modeBPermissionMissing: true,
      }),
      {
        onPostBatch: () => {},
        onSettingsPushResult: (result) => {
          received = result;
        },
      },
    );
    expect(reply).toEqual({ type: "settings-synced" });
    expect(received).toEqual({
      type: "settings-push-result",
      outcome: "applied",
      settings: synced,
      stamp,
      modeBPermissionMissing: true,
    });
  });
});
