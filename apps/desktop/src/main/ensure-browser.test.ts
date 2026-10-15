import { describe, expect, it } from "vitest";
import { note, say } from "../shared/i18n.js";
import { ensureCollectBrowser } from "./ensure-browser.js";
import { waitForConnection } from "./windows-browsers.js";

const NO_BROWSER = note("browserNotInstalled", "vivaldi");

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
      expect(say("en", result.reason)).toContain("Brave was opened");
      expect(say("en", result.reason)).toContain("extension installed in Brave");
      expect(say("tr", result.reason)).toContain("Brave açıldı");
    }
  });

  it("collects in the linked browser when the choice resolves to none, and says so", async () => {
    let launched = false;
    const result = await ensureCollectBrowser({
      resolution: { ok: false, reason: note("browserUnsupportedDefault") },
      isConnected: () => false,
      launch: () => (launched = true),
      waitForConnection: () => Promise.resolve(false),
      anyConnected: () => "brave",
    });
    expect(result).toEqual({
      ok: true,
      launched: false,
      notice: [note("browserUnsupportedDefault"), note("browserFallback", "brave")],
    });
    if (result.ok) {
      expect(result.notice?.map((part) => say("en", part)).join(" ")).toBe(
        "Your default browser is not a supported Chromium browser. Pick a browser for " +
          "collecting in Settings. Collecting in the connected Brave instead.",
      );
    }
    expect(launched).toBe(false);

    const unknown = await ensureCollectBrowser({
      resolution: { ok: false, reason: NO_BROWSER },
      isConnected: () => false,
      launch: () => undefined,
      waitForConnection: () => Promise.resolve(false),
      anyConnected: () => "other",
    });
    expect(unknown.ok && say("en", unknown.notice?.at(-1) ?? null)).toContain(
      "connected browser",
    );

    // Nobody linked: still refused, with the choice's own reason.
    await expect(
      ensureCollectBrowser({
        resolution: { ok: false, reason: NO_BROWSER },
        isConnected: () => false,
        launch: () => undefined,
        waitForConnection: () => Promise.resolve(false),
        anyConnected: () => null,
      }),
    ).resolves.toEqual({ ok: false, reason: NO_BROWSER });
  });

  it("passes an unresolvable choice through and reports a failed launch", async () => {
    await expect(
      ensureCollectBrowser({
        resolution: { ok: false, reason: NO_BROWSER },
        isConnected: () => false,
        launch: () => undefined,
        waitForConnection: () => Promise.resolve(false),
      }),
    ).resolves.toEqual({ ok: false, reason: NO_BROWSER });

    const result = await ensureCollectBrowser({
      resolution: { ok: true, browser: BRAVE },
      isConnected: () => false,
      launch: () => {
        throw new Error("ENOENT");
      },
      waitForConnection: () => Promise.resolve(false),
    });
    expect(!result.ok && say("en", result.reason)).toContain("could not be started");
  });
});
