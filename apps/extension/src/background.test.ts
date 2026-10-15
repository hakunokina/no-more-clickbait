import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fully synthetic HomeTimeline-shaped response shared with core's tests
// (4 organic posts + 1 ad).
const response1 = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "core",
    "fixtures",
    "x-home-timeline",
    "response-1.json",
  ),
  "utf8",
);

type Listener = (...args: unknown[]) => void;

function event() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (listener: Listener) => listeners.push(listener),
    emit: (...args: unknown[]) => listeners.forEach((listener) => listener(...args)),
  };
}

interface FakePort {
  onMessage: ReturnType<typeof event>;
  onDisconnect: ReturnType<typeof event>;
  posted: { type: string }[];
  disconnect: ReturnType<typeof vi.fn>;
  postMessage: (message: { type: string }) => void;
}

/** Just enough of the chrome.* surface background.ts touches. */
function fakeChrome() {
  const ports: FakePort[] = [];
  const local = new Map<string, unknown>();
  const sessionArea = new Map<string, unknown>();
  const runtimeOnMessage = event();
  const storageOnChanged = event();
  const badge = { text: "", color: "" };
  const chrome = {
    runtime: {
      connectNative: () => {
        const port: FakePort = {
          onMessage: event(),
          onDisconnect: event(),
          posted: [],
          disconnect: vi.fn(),
          postMessage: (message) => port.posted.push(message),
        };
        ports.push(port);
        return port;
      },
      onMessage: runtimeOnMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve(local.has(key) ? { [key]: local.get(key) } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [key, newValue] of Object.entries(items)) {
            const oldValue = local.get(key);
            local.set(key, newValue);
            storageOnChanged.emit({ [key]: { oldValue, newValue } }, "local");
          }
          return Promise.resolve();
        },
      },
      session: {
        get: (key: string) =>
          Promise.resolve(sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) sessionArea.set(key, value);
          return Promise.resolve();
        },
        remove: (key: string) => {
          sessionArea.delete(key);
          return Promise.resolve();
        },
      },
      onChanged: storageOnChanged,
    },
    action: {
      setBadgeText: ({ text }: { text: string }) => {
        badge.text = text;
        return Promise.resolve();
      },
      setBadgeBackgroundColor: ({ color }: { color: string }) => {
        badge.color = color;
        return Promise.resolve();
      },
    },
    notifications: { create: vi.fn(() => Promise.resolve("")) },
  };
  return { chrome, ports, badge, sessionArea };
}

let fake: ReturnType<typeof fakeChrome>;

async function setCapture(enabled: boolean, captureTarget = 250): Promise<void> {
  await fake.chrome.storage.local.set({
    "nmc-settings": { devCaptureEnabled: enabled, captureTarget },
  });
}

function captureTimeline(): void {
  fake.chrome.runtime.onMessage.emit({
    kind: "timeline-capture",
    operation: "HomeTimeline",
    bodyText: response1,
  });
}

function stats(uniquePostCount: number) {
  return {
    responseCount: 1,
    postCount: 6,
    uniquePostCount,
    promotedCount: 1,
    oversizedCount: 0,
  };
}

/** Lets the worker's promise chains run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  vi.resetModules();
  await import("./background.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("background worker", () => {
  it("shows its own distinct count while developer capture is off", async () => {
    captureTimeline();
    await settle();
    expect(fake.badge.text).toBe("4");
    expect(fake.ports[0]?.posted.map((m) => m.type)).toEqual(["post-batch"]);
  });

  it("shows the host's count while developer capture is on and skips its own counting", async () => {
    await setCapture(true);
    await settle();
    captureTimeline();
    await settle();
    const port = fake.ports[0];
    expect(port?.posted.map((m) => m.type)).toEqual(["raw-capture", "post-batch"]);
    expect(fake.badge.text).toBe("");
    expect(fake.sessionArea.size).toBe(0); // host is the single source

    port?.onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(17) });
    await settle();
    expect(fake.badge.text).toBe("17");
  });

  it("turns the badge green at the target and back to default on reset", async () => {
    await setCapture(true, 10);
    await settle();
    captureTimeline();
    await settle();
    fake.ports[0]?.onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(10) });
    await settle();
    expect(fake.badge.color).toBe("#137333");
    expect(fake.chrome.notifications.create).toHaveBeenCalledTimes(1);

    await setCapture(false, 10);
    await settle();
    expect(fake.badge.text).toBe("");
    expect(fake.badge.color).toBe("#5f6368");
  });

  it("resets the session and closes the port when capture is toggled", async () => {
    captureTimeline();
    await settle();
    expect(fake.badge.text).toBe("4");
    const oldPort = fake.ports[0];

    await setCapture(true);
    await settle();
    expect(oldPort?.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.badge.text).toBe("");
    expect(fake.sessionArea.size).toBe(0);

    // A late reply from the closed port must not repaint the fresh badge.
    oldPort?.onMessage.emit({ type: "capture-accepted", sequence: 9, stats: stats(99) });
    await settle();
    expect(fake.badge.text).toBe("");

    // The next capture opens a new host session.
    captureTimeline();
    await settle();
    expect(fake.ports).toHaveLength(2);
  });

  it("does not reset when an unrelated setting changes", async () => {
    captureTimeline();
    await settle();
    await fake.chrome.storage.local.set({ "nmc-settings": { timelineSize: 30 } });
    await settle();
    expect(fake.ports[0]?.disconnect).not.toHaveBeenCalled();
    expect(fake.badge.text).toBe("4");
  });

  it("shows '?' and warns when an older host omits uniquePostCount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setCapture(true);
    await settle();
    captureTimeline();
    await settle();
    const { uniquePostCount: _dropped, ...oldStats } = stats(5);
    fake.ports[0]?.onMessage.emit({ type: "capture-accepted", sequence: 1, stats: oldStats });
    await settle();
    expect(fake.badge.text).toBe("?");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pnpm build"));
    expect(fake.chrome.notifications.create).not.toHaveBeenCalled();
  });
});
