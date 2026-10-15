import { describe, expect, it } from "vitest";
import { ipcAllowed } from "./ipc-policy.js";

const READER = "file:///C:/App/dist/renderer/reader.html";
const TIMELINE = "file:///C:/Users/x/AppData/Local/NoMoreClickbait/sessions/s/timeline.html";

describe("IPC policy", () => {
  it("lets the monitor make every call", () => {
    expect(ipcAllowed("nmc:llm-status", "monitor", null, READER)).toBe(true);
    expect(ipcAllowed("nmc:build-timeline", "monitor", null, READER)).toBe(true);
  });

  it("limits the reading window by the page it shows", () => {
    for (const channel of ["nmc:build-timeline", "nmc:open-reader", "nmc:cancel-run"]) {
      expect(ipcAllowed(channel, "reader", READER, READER)).toBe(true);
      expect(ipcAllowed(channel, "reader", TIMELINE, READER)).toBe(false);
      expect(ipcAllowed(channel, "reader", `${READER}?x`, READER)).toBe(false);
    }
    for (const channel of ["nmc:start-collection", "nmc:retry-run"]) {
      expect(ipcAllowed(channel, "reader", TIMELINE, READER)).toBe(true);
    }
    expect(ipcAllowed("nmc:llm-status", "reader", READER, READER)).toBe(false);
    expect(ipcAllowed("nmc:get-status", "reader", TIMELINE, READER)).toBe(false);
  });

  it("refuses unknown senders and destroyed frames", () => {
    expect(ipcAllowed("nmc:get-status", null, READER, READER)).toBe(false);
    expect(ipcAllowed("nmc:get-status", "reader", null, READER)).toBe(false);
  });
});
