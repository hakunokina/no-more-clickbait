import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeReplySchema,
  MANAGED_SETTING_FIELDS,
  ManagedSettingsSchema,
  SettingsSchema,
  SYNCED_SETTING_FIELDS,
  UNSTAMPED,
  type BridgeMessage,
  type ManagedSettingKey,
  type ManagedSettings,
  type Settings,
  type SettingsStamp,
} from "@nmc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The whole path in one place: the desktop's manager, the host's
// handler and file, this extension's push/sync code — real modules.
import { SettingsManager } from "../../desktop/src/main/settings-manager.js";
import {
  DesktopCommandSchema,
  handleBridgeMessage,
  saveSettingsFile,
  SettingsStateEventSchema,
  type BridgeHandlers,
} from "../../../packages/native-host/src/index.js";
import {
  applyPipelineSettings,
  readPipelineForm,
  SYNCED_SETTING_KEYS,
} from "./pipeline-form.js";
import { applySettingsPush, syncSettings } from "./settings-sync.js";

/** A value other than the default for every managed setting. */
function changedValue(key: ManagedSettingKey): ManagedSettings[ManagedSettingKey] {
  const field = MANAGED_SETTING_FIELDS[key];
  if (field.kind === "boolean") return !field.default;
  if (field.kind === "integer")
    return field.default === field.max ? field.min : field.default + 1;
  const other = field.options.find((option) => option.value !== field.default);
  if (!other) throw new Error(`${key} has a single option`);
  return other.value;
}

const KEYS = Object.keys(MANAGED_SETTING_FIELDS) as ManagedSettingKey[];
/** Every managed setting off its default at once. */
const ALL_CHANGED = ManagedSettingsSchema.parse(
  Object.fromEntries(KEYS.map((key) => [key, changedValue(key)])),
);

/** JSON on the wire, as the pipe and native messaging carry it. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("settings round trip (desktop ⇄ host ⇄ extension)", () => {
  let dir: string;
  let settingsPath: string;
  let extension: { settings: Settings; stamp: SettingsStamp };
  let pushes: unknown[];
  let manager: SettingsManager;
  let now: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-roundtrip-"));
    settingsPath = join(dir, "settings.json");
    extension = { settings: SettingsSchema.parse({}), stamp: UNSTAMPED };
    pushes = [];
    now = "2026-10-16T10:00:00.000Z";
    manager = new SettingsManager({
      settingsPath,
      pendingPath: join(dir, "desktop-pending-settings.json"),
      now: () => now,
      sendPush: (settings, stamp) => {
        pushes.push(
          wire(DesktopCommandSchema.parse({ type: "settings-push", settings, stamp })),
        );
        return true;
      },
    });
    await manager.init();
    manager.setBrowserConnected(true);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  /** The host as main.ts wires it: save settings.json, then tell the desktop. */
  const host: BridgeHandlers = {
    onPostBatch: () => undefined,
    onSettingsSync: async (settings, stamp, missing) => {
      const file = await saveSettingsFile(settings, stamp, settingsPath);
      await manager.handleSettingsState(
        SettingsStateEventSchema.parse(
          wire({
            type: "settings-state",
            origin: "sync",
            settings,
            stamp: stamp ?? UNSTAMPED,
            saved: file.written,
            ...(missing.length > 0 ? { extensionMissing: missing } : {}),
          }),
        ),
      );
    },
    onSettingsPushResult: async ({ outcome, settings, stamp }, missing) => {
      const file = await saveSettingsFile(settings, stamp, settingsPath);
      await manager.handleSettingsState(
        SettingsStateEventSchema.parse(
          wire({
            type: "settings-state",
            origin: "push-result",
            outcome,
            settings,
            stamp,
            saved: file.written,
            ...(missing.length > 0 ? { extensionMissing: missing } : {}),
          }),
        ),
      );
    },
  };

  /** The extension's worker: applies the queued push, answers through the host. */
  async function deliverPush(
    reshape: (message: unknown) => unknown = (message) => message,
  ): Promise<void> {
    const push = BridgeReplySchema.parse(reshape(pushes.shift()));
    if (push.type !== "settings-push") throw new Error(`unexpected ${push.type}`);
    const result = await applySettingsPush(push, {
      load: () => Promise.resolve(extension),
      save: (settings, stamp) => {
        extension = { settings, stamp };
        return Promise.resolve();
      },
      modeBPermitted: () => Promise.resolve(true),
    });
    const reply = await handleBridgeMessage(JSON.stringify(reshape(result)), host);
    expect(reply).toEqual({ type: "settings-synced" });
  }

  async function settingsFile(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  }

  it("keeps the Instagram tick on and the X tick off after a desktop change", async () => {
    await manager.change({
      ...manager.state.settings,
      collectFromInstagram: true,
      collectFromX: false,
    });
    await deliverPush();
    const expected = { collectFromInstagram: true, collectFromX: false };
    expect(manager.state).toMatchObject({ pending: false, extensionMissing: [] });
    expect(manager.state.settings).toMatchObject(expected);
    expect(extension.settings).toMatchObject(expected);
    expect(await settingsFile()).toMatchObject(expected);
  });

  it("carries every managed setting from the desktop to the extension and back", async () => {
    await manager.change(ALL_CHANGED);
    await deliverPush();
    expect(manager.state.settings).toEqual(ALL_CHANGED);
    expect(ManagedSettingsSchema.parse(extension.settings)).toEqual(ALL_CHANGED);
    expect(await settingsFile()).toMatchObject(ALL_CHANGED);
  });

  it.each(KEYS)(
    "carries %s on its own from the desktop to the extension and back",
    async (key) => {
      const changed = { ...manager.state.settings, [key]: changedValue(key) };
      await manager.change(changed);
      await deliverPush();
      expect(manager.state.settings).toEqual(changed);
      expect(ManagedSettingsSchema.parse(extension.settings)).toEqual(changed);
    },
  );

  it.each(SYNCED_SETTING_KEYS)(
    "carries %s from an Options save to settings.json and the desktop",
    async (key) => {
      // Options: the form's raw values → validated → stored → synced.
      const wanted = { ...ManagedSettingsSchema.parse({}), [key]: changedValue(key) };
      const form = Object.fromEntries(
        SYNCED_SETTING_KEYS.map((name) => {
          const value = wanted[name];
          return [name, typeof value === "boolean" ? value : String(value)];
        }),
      ) as Parameters<typeof readPipelineForm>[0];
      const read = readPipelineForm(form);
      if (!read.ok) throw new Error(`form rejected ${key}`);
      const stored = applyPipelineSettings(SettingsSchema.parse({}), read.settings);
      const stamp: SettingsStamp = {
        updatedAt: "2026-10-16T11:00:00.000Z",
        source: "extension",
      };
      const result = await syncSettings(
        stored,
        (message: BridgeMessage) => handleBridgeMessage(JSON.stringify(message), host),
        stamp,
      );
      expect(result).toEqual({ status: "synced" });
      expect(Object.keys(SYNCED_SETTING_FIELDS)).toContain(key);
      expect(manager.state.settings[key]).toEqual(wanted[key]);
      expect((await settingsFile())[key]).toEqual(wanted[key]);
    },
  );

  it("names the settings an extension older than them does not know", async () => {
    // An extension built before the source ticks: its schema strips them
    // from the push it reads and from the answer it writes.
    const OLD = ["collectFromX", "collectFromInstagram", "instagramFollowedOnly"];
    const unknownToOld = (message: unknown): unknown => {
      const record = message as { settings?: Record<string, unknown> };
      if (!record.settings) return message;
      const settings = { ...record.settings };
      for (const key of OLD) delete settings[key];
      return { ...record, settings };
    };
    await manager.change({ ...manager.state.settings, collectFromInstagram: true });
    await deliverPush(unknownToOld);
    // The tick cannot stick (that extension cannot collect Instagram)...
    expect(manager.state.settings.collectFromInstagram).toBe(false);
    // ...and the desktop now knows why.
    expect(manager.state.extensionMissing).toEqual(OLD);
  });
});
