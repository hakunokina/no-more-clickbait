import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserFamilyOfProgId,
  defaultBrowserFamily,
  defaultBrowserProgId,
  installedBrowsers,
  launchDetached,
  parseOpenCommand,
  parseRegSubkeys,
  parseRegValue,
  regExeReader,
  waitForConnection,
  type RegistryReader,
} from "./windows-browsers.js";

function fakeReader(entries: {
  values?: Record<string, string>;
  subkeys?: Record<string, string[]>;
}): RegistryReader {
  return {
    readString: (hive, key, valueName) =>
      Promise.resolve(entries.values?.[`${hive}\\${key}::${valueName ?? ""}`] ?? null),
    listSubkeys: (hive, key) => Promise.resolve(entries.subkeys?.[`${hive}\\${key}`] ?? []),
  };
}

const HTTPS = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https";

describe("default browser", () => {
  it("prefers UserChoiceLatest over the classic UserChoice", async () => {
    const reader = fakeReader({
      values: {
        [`HKCU\\${HTTPS}\\UserChoiceLatest\\ProgId::ProgId`]: "BraveOHTML",
        [`HKCU\\${HTTPS}\\UserChoice::ProgId`]: "ChromeHTML",
      },
    });
    await expect(defaultBrowserProgId(reader)).resolves.toBe("BraveOHTML");
    await expect(defaultBrowserFamily(reader)).resolves.toBe("brave");
  });

  it("falls back to UserChoice and maps ProgIds to families", async () => {
    const reader = fakeReader({
      values: { [`HKCU\\${HTTPS}\\UserChoice::ProgId`]: "MSEdgeHTM" },
    });
    await expect(defaultBrowserFamily(reader)).resolves.toBe("edge");
    expect(browserFamilyOfProgId("ChromeHTML")).toBe("chrome");
    expect(browserFamilyOfProgId("VivaldiHTM.AB12")).toBe("vivaldi");
    expect(browserFamilyOfProgId("OperaStable")).toBe("opera");
    expect(browserFamilyOfProgId("FirefoxURL-308046B0AF4A39CB")).toBeNull();
  });

  it("returns null when nothing is registered", async () => {
    await expect(defaultBrowserFamily(fakeReader({}))).resolves.toBeNull();
  });
});

describe("installed browsers", () => {
  it("lists Chromium clients from both hives, HKCU shadowing, others skipped", async () => {
    const SMI = "SOFTWARE\\Clients\\StartMenuInternet";
    const reader = fakeReader({
      subkeys: {
        [`HKCU\\${SMI}`]: ["Vivaldi.XX", "Firefox-1"],
        [`HKLM\\${SMI}`]: ["Brave", "Google Chrome", "Vivaldi"],
      },
      values: {
        [`HKCU\\${SMI}\\Vivaldi.XX\\shell\\open\\command::`]:
          '"C:\\Users\\a\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe"',
        [`HKCU\\${SMI}\\Firefox-1\\shell\\open\\command::`]:
          '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
        [`HKLM\\${SMI}\\Brave\\shell\\open\\command::`]:
          '"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1',
        [`HKLM\\${SMI}\\Google Chrome\\shell\\open\\command::`]:
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1',
        [`HKLM\\${SMI}\\Vivaldi\\shell\\open\\command::`]: '"D:\\V\\vivaldi.exe"',
      },
    });
    const installed = await installedBrowsers(reader);
    expect(installed.map((b) => b.family).sort()).toEqual(["brave", "chrome", "vivaldi"]);
    expect(installed.find((b) => b.family === "vivaldi")?.exePath).toContain("AppData");
  });

  it("parses open commands", () => {
    expect(parseOpenCommand('"C:\\X\\brave.exe" --flag %1')).toBe("C:\\X\\brave.exe");
    expect(parseOpenCommand("C:\\X\\msedge.exe %1")).toBe("C:\\X\\msedge.exe");
    expect(parseOpenCommand("rundll32 whatever")).toBeNull();
  });
});

describe("reg.exe output parsing", () => {
  it("reads named and default values", () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\X\r\n    ProgId    REG_SZ    BraveOHTML\r\n    (Default)    REG_SZ    "C:\\\\brave.exe"\r\n';
    expect(parseRegValue(out, "ProgId")).toBe("BraveOHTML");
    expect(parseRegValue(out, null)).toBe('"C:\\\\brave.exe"');
    expect(parseRegValue(out, "Missing")).toBeNull();
  });

  it("lists only direct subkeys", () => {
    const key = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet";
    const out = `${key}\r\n${key}\\Brave\r\n${key}\\Brave\\shell\r\n${key}\\Microsoft Edge\r\n`;
    expect(parseRegSubkeys(out, key)).toEqual(["Brave", "Microsoft Edge"]);
  });

  it("builds query args without a shell", async () => {
    const calls: string[][] = [];
    const reader = regExeReader((args) => {
      calls.push(args);
      return Promise.resolve("    ProgId    REG_SZ    ChromeHTML\r\n");
    });
    await expect(reader.readString("HKCU", "Software\\X", "ProgId")).resolves.toBe(
      "ChromeHTML",
    );
    await reader.listSubkeys("HKLM", "SOFTWARE\\Y");
    expect(calls[0]).toEqual(["query", "HKCU\\Software\\X", "/v", "ProgId"]);
    expect(calls[1]).toEqual(["query", "HKLM\\SOFTWARE\\Y"]);
  });
});

describe("waitForConnection", () => {
  it("resolves true as soon as connected", async () => {
    let checks = 0;
    await expect(
      waitForConnection(() => ++checks >= 3, { timeoutMs: 1_000, intervalMs: 1 }),
    ).resolves.toBe(true);
  });

  it("times out with false", async () => {
    await expect(
      waitForConnection(() => false, { timeoutMs: 20, intervalMs: 5 }),
    ).resolves.toBe(false);
  });
});

describe("launchDetached", () => {
  it("fails at once for a browser path that no longer exists", () => {
    expect(() => launchDetached(join(tmpdir(), "nmc-missing-browser", "brave.exe"))).toThrow(
      /not found/,
    );
  });
});
