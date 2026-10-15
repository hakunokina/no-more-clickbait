import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hostMatchesBrowser,
  loadBrowserChoice,
  parseBrowserChoice,
  resolveCollectBrowser,
  saveBrowserChoice,
} from "./browser-choice.js";

const BRAVE = { family: "brave" as const, exePath: "C:\\Brave\\brave.exe" };
const EDGE = { family: "edge" as const, exePath: "C:\\Edge\\msedge.exe" };

describe("browser choice file", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nmc-choice-"));
    path = join(dir, "browser-choice.json");
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("defaults to the system default and round-trips a family", async () => {
    await expect(loadBrowserChoice(path)).resolves.toBe("default");
    await saveBrowserChoice("edge", path);
    await expect(loadBrowserChoice(path)).resolves.toBe("edge");
  });

  it("falls back to default on junk", async () => {
    await writeFile(path, "{ not json", "utf8");
    await expect(loadBrowserChoice(path)).resolves.toBe("default");
    expect(parseBrowserChoice({ choice: "netscape" })).toBe("default");
    expect(parseBrowserChoice({ choice: "other" })).toBe("default");
    expect(parseBrowserChoice(null)).toBe("default");
  });
});

describe("resolveCollectBrowser", () => {
  const installed = [BRAVE, EDGE];

  it("uses the system default for the default choice", () => {
    expect(resolveCollectBrowser("default", "edge", installed)).toEqual({
      ok: true,
      browser: EDGE,
    });
  });

  it("honours an explicit choice over the system default", () => {
    expect(resolveCollectBrowser("brave", "edge", installed)).toEqual({
      ok: true,
      browser: BRAVE,
    });
  });

  it("explains an unsupported or missing default", () => {
    expect(resolveCollectBrowser("default", null, installed)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a supported Chromium browser"),
    });
    expect(resolveCollectBrowser("default", "chrome", installed)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Chrome"),
    });
    expect(resolveCollectBrowser("vivaldi", "brave", installed)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not installed"),
    });
  });
});

describe("hostMatchesBrowser", () => {
  it("matches by exact executable when the host reported one", () => {
    expect(
      hostMatchesBrowser({ family: "brave", exePath: "c:\\brave\\BRAVE.EXE" }, BRAVE),
    ).toBe(true);
    expect(
      hostMatchesBrowser({ family: "brave", exePath: "C:\\BraveOrigin\\brave.exe" }, BRAVE),
    ).toBe(false);
  });

  it("falls back to family when the host has no path, and never across families", () => {
    expect(hostMatchesBrowser({ family: "brave", exePath: null }, BRAVE)).toBe(true);
    expect(hostMatchesBrowser({ family: "edge", exePath: null }, BRAVE)).toBe(false);
  });
});
