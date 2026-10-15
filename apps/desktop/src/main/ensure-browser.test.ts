import { describe, expect, it } from "vitest";
import { ensureCollectBrowser } from "./ensure-browser.js";
import { waitForConnection } from "./windows-browsers.js";

const BRAVE = { family: "brave" as const, exePath: "C:\\Brave\\brave.exe" };

describe("ensureCollectBrowser", () => {
  it("does nothing when the chosen browser is already connected", async () => {
    let launched = false;
    const result = await ensureCollectBrowser({
      resolution: { ok: true, browser: BRAVE },
      isConnected: () => true,
      launch: () => (launched = true),
      waitForConnection: () => Promise.resolve(true),
    });
    expect(result).toEqual({ ok: true, launched: false });
    expect(launched).toBe(false);
  });

  it("launches the browser and waits for the extension to link up", async () => {
    let connected = false;
    const launchedWith: string[] = [];
    const result = await ensureCollectBrowser({
      resolution: { ok: true, browser: BRAVE },
      isConnected: () => connected,
      launch: (exePath) => {
        launchedWith.push(exePath);
        connected = true;
      },
      waitForConnection: (check) => waitForConnection(check, { timeoutMs: 100, intervalMs: 1 }),
    });
    expect(result).toEqual({ ok: true, launched: true });
    expect(launchedWith).toEqual([BRAVE.exePath]);
  });

  it("times out with an install-the-extension message naming the browser", async () => {
    const result = await ensureCollectBrowser({
      resolution: { ok: true, browser: BRAVE },
      isConnected: () => false,
      launch: () => undefined,
      waitForConnection: (check) => waitForConnection(check, { timeoutMs: 20, intervalMs: 5 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Brave was opened");
      expect(result.reason).toContain("extension installed in Brave");
    }
  });

  it("passes an unresolvable choice through and reports a failed launch", async () => {
    await expect(
      ensureCollectBrowser({
        resolution: { ok: false, reason: "no browser" },
        isConnected: () => false,
        launch: () => undefined,
        waitForConnection: () => Promise.resolve(false),
      }),
    ).resolves.toEqual({ ok: false, reason: "no browser" });

    const result = await ensureCollectBrowser({
      resolution: { ok: true, browser: BRAVE },
      isConnected: () => false,
      launch: () => {
        throw new Error("ENOENT");
      },
      waitForConnection: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("could not be started") });
  });
});
