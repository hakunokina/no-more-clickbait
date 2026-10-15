import { SettingsSchema, type BridgeMessage, type Settings, type SettingsStamp } from "@nmc/core";
import { describe, expect, it, vi } from "vitest";
import {
  applySettingsPush,
  createSettingsSyncer,
  describeSyncResult,
  syncSettings,
} from "./settings-sync.js";

const settings = SettingsSchema.parse({
  maxClickbait: 5,
  devCaptureEnabled: true,
  modeBEnabled: true,
});

describe("syncSettings", () => {
  it("sends the managed settings with their stamp and reports success", async () => {
    const sent: BridgeMessage[] = [];
    const stamp: SettingsStamp = { updatedAt: "2026-10-15T10:00:00.000Z", source: "extension" };
    const result = await syncSettings(
      { ...settings, modeBTarget: 80 },
      (message) => {
        sent.push(message);
        return Promise.resolve({ type: "settings-synced" });
      },
      stamp,
    );
    expect(result).toEqual({ status: "synced" });
    expect(sent).toEqual([
      {
        type: "settings-sync",
        settings: {
          collectTarget: 250,
          timelineSize: 50,
          maxClickbait: 5,
          minReadValue: 2,
          minReadForVerify: 4,
          maxVerifications: 20,
          verifyEnabled: true,
          modeBEnabled: true,
          modeBStrategy: "minimized-window",
          modeBPacing: "normal",
          devCaptureEnabled: true,
        },
        stamp,
      },
    ]);
    expect(describeSyncResult(result)).toBe("");
  });

  it("is unreachable when no host is registered", async () => {
    const result = await syncSettings(settings, () =>
      Promise.reject(new Error("Specified native messaging host not found.")),
    );
    expect(result.status).toBe("unreachable");
    expect(describeSyncResult(result)).toContain("saved in the extension");
  });

  it("is rejected by an older host that does not know settings-sync", async () => {
    const result = await syncSettings(settings, () =>
      Promise.resolve({
        type: "error",
        message: "invalid bridge message: Invalid discriminator value",
      }),
    );
    expect(result).toEqual({
      status: "rejected",
      detail: "invalid bridge message: Invalid discriminator value",
    });
    expect(describeSyncResult(result)).toContain("pnpm build");
  });

  it("treats a malformed or unrelated reply as rejected", async () => {
    await expect(
      syncSettings(settings, () => Promise.resolve(undefined)),
    ).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(
      syncSettings(settings, () => Promise.resolve({ type: "pong" })),
    ).resolves.toEqual({ status: "rejected", detail: "unexpected pong" });
  });

  it("refuses to send invalid settings", async () => {
    await expect(
      syncSettings({ ...settings, maxClickbait: 42 }, () => Promise.resolve({})),
    ).rejects.toThrow();
  });
});

describe("createSettingsSyncer", () => {
  it("runs one exchange at a time and sends only the latest of the queued saves", async () => {
    const sent: number[] = [];
    const replies: (() => void)[] = [];
    const sync = createSettingsSyncer((message) => {
      if (message.type === "settings-sync") sent.push(message.settings.maxClickbait);
      return new Promise((resolve) => replies.push(() => resolve({ type: "settings-synced" })));
    });
    const first = sync({ ...settings, maxClickbait: 1 });
    const second = sync({ ...settings, maxClickbait: 2 });
    const third = sync({ ...settings, maxClickbait: 3 });
    await Promise.resolve();
    expect(sent).toEqual([1]);
    replies.shift()?.();
    await expect(first).resolves.toEqual({ status: "synced" });
    await vi.waitFor(() => expect(sent).toEqual([1, 3]));
    replies.shift()?.();
    await expect(Promise.all([second, third])).resolves.toEqual([
      { status: "synced" },
      { status: "synced" },
    ]);
    expect(sent).toEqual([1, 3]);
    // Idle again: the next save goes straight out.
    void sync({ ...settings, maxClickbait: 4 });
    await vi.waitFor(() => expect(sent).toEqual([1, 3, 4]));
  });

  it("keeps working after a sync fails or throws", async () => {
    const sync = createSettingsSyncer(() => Promise.reject(new Error("no host")));
    await expect(sync({ ...settings, maxClickbait: 42 })).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(sync(settings)).resolves.toMatchObject({ status: "unreachable" });
  });
});

describe("applySettingsPush", () => {
  const at = (updatedAt: string, source: SettingsStamp["source"]): SettingsStamp => ({
    updatedAt,
    source,
  });
  const OWN = at("2026-10-15T10:00:00.000Z", "extension");

  function store(initial: Settings, stamp: SettingsStamp, permitted = true) {
    const state = { settings: initial, stamp, saves: 0 };
    return {
      state,
      deps: {
        load: () => Promise.resolve({ settings: state.settings, stamp: state.stamp }),
        save: (next: Settings, nextStamp: SettingsStamp) => {
          state.settings = next;
          state.stamp = nextStamp;
          state.saves += 1;
          return Promise.resolve();
        },
        modeBPermitted: () => Promise.resolve(permitted),
      },
    };
  }

  it("applies a later desktop change and answers with what it now holds", async () => {
    const { state, deps } = store(SettingsSchema.parse({ modeBTarget: 100 }), OWN);
    const stamp = at("2026-10-15T10:05:00.000Z", "desktop");
    const pushed = { ...SettingsSchema.parse({}), maxClickbait: 3, collectTarget: 400 };
    const result = await applySettingsPush({ settings: pushed, stamp }, deps);
    expect(result).toMatchObject({
      type: "settings-push-result",
      outcome: "applied",
      stamp,
      settings: { maxClickbait: 3, collectTarget: 400 },
    });
    expect(result.modeBPermissionMissing).toBeUndefined();
    expect(state.stamp).toEqual(stamp);
    expect(state.settings).toMatchObject({ maxClickbait: 3, collectTarget: 400 });
    // The deprecated Mode B target mirrors the collection target, as on Save.
    expect(state.settings.modeBTarget).toBe(400);
  });

  it("keeps its own later save and answers with it", async () => {
    const own = SettingsSchema.parse({ maxClickbait: 6 });
    const { state, deps } = store(own, OWN);
    const result = await applySettingsPush(
      { settings: { ...own, maxClickbait: 2 }, stamp: at("2026-10-15T09:00:00.000Z", "desktop") },
      deps,
    );
    expect(result).toMatchObject({
      outcome: "kept-newer",
      stamp: OWN,
      settings: { maxClickbait: 6 },
    });
    expect(state.saves).toBe(0);
  });

  it("never turns Mode B on without its permission", async () => {
    const { state, deps } = store(SettingsSchema.parse({}), OWN, false);
    const result = await applySettingsPush(
      {
        settings: { ...SettingsSchema.parse({}), modeBEnabled: true, modeBPacing: "fast" },
        stamp: at("2026-10-15T10:05:00.000Z", "desktop"),
      },
      deps,
    );
    expect(result).toMatchObject({
      outcome: "applied",
      modeBPermissionMissing: true,
      settings: { modeBEnabled: false, modeBPacing: "fast" },
    });
    expect(state.settings.modeBEnabled).toBe(false);
  });
});
