import { SettingsSchema, type BridgeMessage } from "@nmc/core";
import { describe, expect, it, vi } from "vitest";
import { createSettingsSyncer, describeSyncResult, syncSettings } from "./settings-sync.js";

const settings = SettingsSchema.parse({
  maxClickbait: 5,
  devCaptureEnabled: true,
  modeBEnabled: true,
});

describe("syncSettings", () => {
  it("sends only the synced pipeline settings and reports success", async () => {
    const sent: BridgeMessage[] = [];
    const result = await syncSettings(settings, (message) => {
      sent.push(message);
      return Promise.resolve({ type: "settings-synced" });
    });
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
        },
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
