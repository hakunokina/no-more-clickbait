import { describe, expect, it, vi } from "vitest";
import {
  DEV_CAPTURE_SCRIPTS,
  installDevCaptureScripts,
  syncDevCaptureScripts,
  type ScriptingApi,
} from "./dev-capture-scripts.js";

/** A fake `chrome.scripting` holding registrations by id, like the browser. */
function fakeScripting(initial: string[] = []) {
  const registered = new Map<string, chrome.scripting.RegisteredContentScript>(
    initial.map((id) => [id, { id }]),
  );
  const api = {
    getRegisteredContentScripts: vi.fn((filter?: { ids?: string[] }) =>
      Promise.resolve(
        [...registered.values()].filter(
          (script) => !filter?.ids || filter.ids.includes(script.id),
        ),
      ),
    ),
    registerContentScripts: vi.fn((scripts: chrome.scripting.RegisteredContentScript[]) => {
      for (const script of scripts) {
        if (registered.has(script.id))
          return Promise.reject(new Error(`Duplicate script ID '${script.id}'`));
      }
      for (const script of scripts) registered.set(script.id, script);
      return Promise.resolve();
    }),
    unregisterContentScripts: vi.fn((filter?: { ids?: string[] }) => {
      for (const id of filter?.ids ?? [...registered.keys()]) registered.delete(id);
      return Promise.resolve();
    }),
  } satisfies ScriptingApi;
  return { api, registered };
}

type Listener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

function fakeStorage(settings?: Record<string, unknown>) {
  const local = new Map<string, unknown>(settings ? [["nmc-settings", settings]] : []);
  const listeners: Listener[] = [];
  const storage = {
    local: {
      get: (key: string) => Promise.resolve(local.has(key) ? { [key]: local.get(key) } : {}),
    },
    onChanged: { addListener: (listener: Listener) => listeners.push(listener) },
  } as unknown as Pick<typeof chrome.storage, "local" | "onChanged">;
  const set = (newValue: Record<string, unknown>): void => {
    const oldValue = local.get("nmc-settings");
    local.set("nmc-settings", newValue);
    for (const listener of listeners)
      listener({ "nmc-settings": { oldValue, newValue } }, "local");
  };
  return { storage, set };
}

const IDS = ["nmc-reddit-injected", "nmc-instagram-injected"];

describe("developer capture MAIN-world scripts", () => {
  it("registers only the Reddit and Instagram listeners, MAIN world at document_start", () => {
    expect(DEV_CAPTURE_SCRIPTS.map((script) => [script.id, script.js, script.matches])).toEqual(
      [
        ["nmc-reddit-injected", ["reddit-injected.js"], ["https://www.reddit.com/*"]],
        ["nmc-instagram-injected", ["instagram-injected.js"], ["https://www.instagram.com/*"]],
      ],
    );
    for (const script of DEV_CAPTURE_SCRIPTS) {
      expect(script.world).toBe("MAIN");
      expect(script.runAt).toBe("document_start");
    }
  });

  it("sync registers when on, unregisters when off, and leaves other scripts alone", async () => {
    const { api, registered } = fakeScripting(["nmc-site-hook"]);
    await syncDevCaptureScripts(api, true);
    expect([...registered.keys()].sort()).toEqual(["nmc-site-hook", ...IDS].sort());
    await syncDevCaptureScripts(api, true);
    expect(api.registerContentScripts).toHaveBeenCalledTimes(1);
    await syncDevCaptureScripts(api, false);
    expect([...registered.keys()]).toEqual(["nmc-site-hook"]);
    for (const call of api.unregisterContentScripts.mock.calls) {
      expect(call[0]?.ids).toBeDefined();
    }
  });

  it("repairs a half registration", async () => {
    const { api, registered } = fakeScripting(["nmc-reddit-injected"]);
    await syncDevCaptureScripts(api, true);
    expect([...registered.keys()].sort()).toEqual([...IDS].sort());
  });

  it("registers nothing while the tick is off (the default)", async () => {
    const { api, registered } = fakeScripting();
    const sync = installDevCaptureScripts(api, fakeStorage().storage);
    await sync();
    expect(registered.size).toBe(0);
    expect(api.registerContentScripts).not.toHaveBeenCalled();
  });

  it("follows the stored tick on and off, settling on the last value", async () => {
    const { api, registered } = fakeScripting();
    const { storage, set } = fakeStorage({ devCaptureEnabled: true });
    const sync = installDevCaptureScripts(api, storage);
    await sync();
    expect([...registered.keys()].sort()).toEqual([...IDS].sort());

    set({ devCaptureEnabled: false });
    await sync();
    expect(registered.size).toBe(0);

    set({ devCaptureEnabled: true });
    set({ devCaptureEnabled: false });
    set({ devCaptureEnabled: true });
    await sync();
    expect([...registered.keys()].sort()).toEqual([...IDS].sort());
  });

  it("ignores changes that leave the tick as it was", async () => {
    const { api } = fakeScripting();
    const { storage, set } = fakeStorage({ devCaptureEnabled: false });
    const sync = installDevCaptureScripts(api, storage);
    await sync();
    const reads = api.getRegisteredContentScripts.mock.calls.length;
    set({ devCaptureEnabled: false, collectTarget: 100 });
    await sync();
    // Only the explicit sync above read the registrations.
    expect(api.getRegisteredContentScripts.mock.calls.length).toBe(reads + 1);
  });

  it("a failed sync is logged and does not block the next one", async () => {
    const { api, registered } = fakeScripting();
    api.registerContentScripts.mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { storage } = fakeStorage({ devCaptureEnabled: true });
    const sync = installDevCaptureScripts(api, storage);
    await sync();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    await sync();
    expect([...registered.keys()].sort()).toEqual([...IDS].sort());
    error.mockRestore();
  });
});
