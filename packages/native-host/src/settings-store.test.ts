import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncedSettingsSchema, type SyncedSettings } from "@nmc/core";
import { loadSettings } from "@nmc/core/settings-file";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";
import { defaultSettingsPath, saveSyncedSettings } from "./settings-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nmc-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const synced: SyncedSettings = SyncedSettingsSchema.parse({
  maxClickbait: 5,
  timelineSize: 30,
});

describe("defaultSettingsPath", () => {
  it("lives under %LOCALAPPDATA%\\NoMoreClickbait", () => {
    expect(defaultSettingsPath({ LOCALAPPDATA: "C:\\App" })).toBe(
      join("C:\\App", "NoMoreClickbait", "settings.json"),
    );
  });
});

describe("saveSyncedSettings", () => {
  it("writes BOM-less JSON the desktop's loadSettings reads back", async () => {
    const path = join(dir, "nested", "settings.json");
    await saveSyncedSettings(synced, path);
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(synced);
    const loaded = await loadSettings(path);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.settings).toMatchObject(synced);
  });

  it("replaces the previous file and leaves no temp file behind", async () => {
    const path = join(dir, "settings.json");
    await saveSyncedSettings(synced, path);
    await saveSyncedSettings({ ...synced, maxClickbait: 9 }, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ maxClickbait: 9 });
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("refuses invalid settings without touching the file", async () => {
    const path = join(dir, "settings.json");
    await saveSyncedSettings(synced, path);
    await expect(saveSyncedSettings({ ...synced, timelineSize: 0 }, path)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(synced);
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
      onSettingsSync: (settings) => saveSyncedSettings(settings, path),
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

  it("drops unknown keys so only pipeline settings reach the file", async () => {
    let received: unknown;
    await handleBridgeMessage(
      JSON.stringify({
        type: "settings-sync",
        settings: { ...synced, devCaptureEnabled: true },
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
