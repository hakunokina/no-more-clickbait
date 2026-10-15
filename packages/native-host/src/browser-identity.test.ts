import { describe, expect, it } from "vitest";
import {
  browserFamilyOfExe,
  identifyBrowser,
  identifyFromAncestors,
  UNKNOWN_BROWSER,
} from "./browser-identity.js";

const BRAVE = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

describe("browserFamilyOfExe", () => {
  it("knows the supported Chromium browsers by file name", () => {
    expect(browserFamilyOfExe(BRAVE)).toBe("brave");
    expect(browserFamilyOfExe("C:\\X\\Chrome.EXE")).toBe("chrome");
    expect(browserFamilyOfExe("msedge.exe")).toBe("edge");
    expect(browserFamilyOfExe("C:/Users/a/AppData/Local/Vivaldi/Application/vivaldi.exe")).toBe(
      "vivaldi",
    );
    expect(browserFamilyOfExe("firefox.exe")).toBeNull();
  });
});

describe("identifyFromAncestors", () => {
  it("skips the launcher shell and takes the browser (measured chain)", () => {
    expect(
      identifyFromAncestors([
        { name: "cmd.exe", exePath: "C:\\WINDOWS\\system32\\cmd.exe" },
        { name: "brave.exe", exePath: BRAVE },
        { name: "explorer.exe", exePath: "C:\\WINDOWS\\Explorer.EXE" },
      ]),
    ).toEqual({ family: "brave", exePath: BRAVE });
  });

  it("says `other` when the first real ancestor is not a supported browser", () => {
    expect(
      identifyFromAncestors([
        { name: "cmd.exe", exePath: null },
        { name: "explorer.exe", exePath: null },
        { name: "chrome.exe", exePath: null },
      ]),
    ).toEqual(UNKNOWN_BROWSER);
    expect(identifyFromAncestors([])).toEqual(UNKNOWN_BROWSER);
  });
});

describe("identifyBrowser", () => {
  it("asks for the parent's ancestors on Windows", async () => {
    const asked: number[] = [];
    const identity = await identifyBrowser(
      42,
      (pid) => {
        asked.push(pid);
        return Promise.resolve([
          { name: "cmd.exe", exePath: null },
          { name: "msedge.exe", exePath: "C:\\E\\msedge.exe" },
        ]);
      },
      "win32",
    );
    expect(asked).toEqual([42]);
    expect(identity).toEqual({ family: "edge", exePath: "C:\\E\\msedge.exe" });
  });

  it("falls back to `other` when the lookup fails or off Windows", async () => {
    await expect(
      identifyBrowser(1, () => Promise.reject(new Error("no powershell")), "win32"),
    ).resolves.toEqual(UNKNOWN_BROWSER);
    await expect(
      identifyBrowser(
        1,
        () => Promise.resolve([{ name: "brave.exe", exePath: null }]),
        "linux",
      ),
    ).resolves.toEqual(UNKNOWN_BROWSER);
  });
});
