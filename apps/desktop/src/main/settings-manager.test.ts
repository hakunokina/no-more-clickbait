import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSettingsSchema, type ManagedSettings, type SettingsStamp } from "@nmc/core";
import type { SettingsStateEvent } from "@nmc/native-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";

const T1 = "2026-10-15T10:00:00.000Z";
const T2 = "2026-10-15T11:00:00.000Z";
const T3 = "2026-10-15T12:00:00.000Z";

const defaults = ManagedSettingsSchema.parse({});
const changed: ManagedSettings = { ...defaults, maxClickbait: 3, collectTarget: 400 };

function stamp(updatedAt: string, source: SettingsStamp["source"]): SettingsStamp {
  return { updatedAt, source };
}

describe("SettingsManager", () => {
  let dir: string;
  let settingsPath: string;
  let pendingPath: string;
  let pushes: { settings: ManagedSettings; stamp: SettingsStamp }[];
  let now: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-settings-mgr-"));
    settingsPath = join(dir, "settings.json");
    pendingPath = join(dir, "desktop-pending-settings.json");
    pushes = [];
    now = T2;
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  function manager(): SettingsManager {
    return new SettingsManager({
      settingsPath,
      pendingPath,
      now: () => now,
      sendPush: (settings, stamp) => {
        pushes.push({ settings, stamp });
        return true;
      },
    });
  }

  async function writeSettingsFile(settings: ManagedSettings, at: string): Promise<void> {
    await writeFile(
      settingsPath,
      JSON.stringify({ ...settings, updatedAt: at, source: "extension" }),
      "utf8",
    );
  }

  async function pendingExists(): Promise<boolean> {
    return access(pendingPath).then(
      () => true,
      () => false,
    );
  }

  function stateEvent(partial: Partial<SettingsStateEvent>): SettingsStateEvent {
    return {
      type: "settings-state",
      origin: "sync",
      settings: defaults,
      stamp: stamp(T1, "extension"),
      saved: true,
      ...partial,
    };
  }

  it("starts from settings.json with its stamp", async () => {
    await writeSettingsFile(changed, T1);
    const mgr = manager();
    await mgr.init();
    expect(mgr.state.settings).toEqual(changed);
    expect(mgr.state.stamp).toEqual(stamp(T1, "extension"));
    expect(mgr.state.pending).toBe(false);
  });

  it("keeps a disconnected change pending across restarts, then delivers it", async () => {
    await writeSettingsFile(defaults, T1);
    const first = manager();
    await first.init();
    await first.change(changed);
    expect(first.state.pending).toBe(true);
    expect(pushes).toEqual([]);
    expect(await pendingExists()).toBe(true);

    const second = manager();
    await second.init();
    expect(second.state.settings).toEqual(changed);
    expect(second.state.pending).toBe(true);

    second.setBrowserConnected(true);
    expect(pushes).toEqual([{ settings: changed, stamp: stamp(T2, "desktop") }]);

    await second.handleSettingsState(
      stateEvent({
        origin: "push-result",
        outcome: "applied",
        settings: changed,
        stamp: stamp(T2, "desktop"),
      }),
    );
    expect(second.state.pending).toBe(false);
    expect(await pendingExists()).toBe(false);
  });

  it("pushes the pending change when the extension reports older settings", async () => {
    await writeSettingsFile(defaults, T1);
    const mgr = manager();
    await mgr.init();
    await mgr.change(changed);
    mgr.setBrowserConnected(true);
    pushes = [];
    await mgr.handleSettingsState(
      stateEvent({ settings: defaults, stamp: stamp(T1, "extension") }),
    );
    // Already sent on connect; the report does not displace the pending change.
    expect(mgr.state.settings).toEqual(changed);
    expect(mgr.state.pending).toBe(true);
    expect(pushes).toEqual([{ settings: changed, stamp: stamp(T2, "desktop") }]);
  });

  it("drops the pending change when the extension saved later", async () => {
    await writeSettingsFile(defaults, T1);
    const mgr = manager();
    await mgr.init();
    await mgr.change(changed);
    const extensionLater = { ...defaults, maxClickbait: 9 };
    await mgr.handleSettingsState(
      stateEvent({ settings: extensionLater, stamp: stamp(T3, "extension") }),
    );
    expect(mgr.state.settings).toEqual(extensionLater);
    expect(mgr.state.pending).toBe(false);
    expect(await pendingExists()).toBe(false);
  });

  it("accepts a kept-newer push answer and surfaces a missing Mode B permission", async () => {
    await writeSettingsFile(defaults, T1);
    const mgr = manager();
    await mgr.init();
    mgr.setBrowserConnected(true);
    await mgr.change({ ...changed, modeBEnabled: true });
    expect(pushes).toHaveLength(1);

    await mgr.handleSettingsState(
      stateEvent({
        origin: "push-result",
        outcome: "applied",
        settings: { ...changed, modeBEnabled: false },
        stamp: stamp(T2, "desktop"),
        modeBPermissionMissing: true,
      }),
    );
    expect(mgr.state.settings.modeBEnabled).toBe(false);
    expect(mgr.state.modeBPermissionMissing).toBe(true);
    expect(mgr.state.pending).toBe(false);
  });

  it("shows an Options save reported over the link, so the next desktop save keeps it", async () => {
    await writeSettingsFile(defaults, T1);
    const mgr = manager();
    await mgr.init();
    mgr.setBrowserConnected(true);
    const fromOptions = { ...defaults, timelineSize: 50 };
    await mgr.handleSettingsState(
      stateEvent({ origin: "sync", settings: fromOptions, stamp: stamp(T2, "extension") }),
    );
    expect(mgr.state.settings).toEqual(fromOptions);
    expect(mgr.state.stamp).toEqual(stamp(T2, "extension"));

    // The desktop form saves from what it shows: the Options value rides along.
    now = T3;
    await mgr.change({ ...mgr.state.settings, maxClickbait: 3 });
    expect(pushes.at(-1)).toEqual({
      settings: { ...defaults, timelineSize: 50, maxClickbait: 3 },
      stamp: stamp(T3, "desktop"),
    });
  });

  it("keeps a later pending change when an older push is answered", async () => {
    const mgr = manager();
    await mgr.init();
    mgr.setBrowserConnected(true);
    const first = { ...defaults, maxClickbait: 3 };
    const second = { ...defaults, maxClickbait: 5 };
    now = T2;
    await mgr.change(first);
    now = T3;
    await mgr.change(second);
    expect(pushes).toHaveLength(2);

    // The first push's answer arrives while the second is still on its way.
    await mgr.handleSettingsState(
      stateEvent({ origin: "push-result", settings: first, stamp: stamp(T2, "desktop") }),
    );
    expect(mgr.state.settings).toEqual(second);
    expect(mgr.state.pending).toBe(true);
    expect(await pendingExists()).toBe(true);
    expect(pushes.at(-1)).toEqual({ settings: second, stamp: stamp(T3, "desktop") });

    // Its own answer settles it.
    await mgr.handleSettingsState(
      stateEvent({ origin: "push-result", settings: second, stamp: stamp(T3, "desktop") }),
    );
    expect(mgr.state.pending).toBe(false);
    expect(await pendingExists()).toBe(false);
  });

  it("does not send while disconnected, and a spent pending file is cleaned at init", async () => {
    await writeSettingsFile(changed, T3);
    await writeFile(
      pendingPath,
      JSON.stringify({ settings: defaults, stamp: stamp(T1, "desktop") }),
      "utf8",
    );
    const mgr = manager();
    await mgr.init();
    expect(mgr.state.settings).toEqual(changed);
    expect(mgr.state.pending).toBe(false);
    expect(await pendingExists()).toBe(false);
  });
});
