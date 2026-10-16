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
const response2 = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "core",
    "fixtures",
    "x-home-timeline",
    "response-2.json",
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
  const tabsOnRemoved = event();
  const badge = { text: "", color: "" };
  const granted = new Set<string>(["alarms"]);
  const chrome = {
    runtime: {
      id: "test",
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
      onStartup: event(),
      onInstalled: event(),
      sendNativeMessage: vi.fn((_host: string, _message: unknown): Promise<unknown> =>
        Promise.resolve({ type: "settings-synced" }),
      ),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: {
        get: (keys: string | string[] | null) =>
          Promise.resolve(
            Object.fromEntries(
              keys === null
                ? [...local]
                : [keys]
                    .flat()
                    .flatMap((key) => (local.has(key) ? [[key, local.get(key)]] : [])),
            ),
          ),
        set: (items: Record<string, unknown>) => {
          for (const [key, newValue] of Object.entries(items)) {
            const oldValue = local.get(key);
            local.set(key, newValue);
            storageOnChanged.emit({ [key]: { oldValue, newValue } }, "local");
          }
          return Promise.resolve();
        },
        remove: (keys: string | string[]) => {
          for (const key of [keys].flat()) local.delete(key);
          return Promise.resolve();
        },
      },
      session: {
        get: (keys: string | string[]) =>
          Promise.resolve(
            Object.fromEntries(
              [keys]
                .flat()
                .flatMap((key) => (sessionArea.has(key) ? [[key, sessionArea.get(key)]] : [])),
            ),
          ),
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
    scripting: {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
    },
    permissions: {
      contains: ({
        permissions = [],
        origins = [],
      }: {
        permissions?: string[];
        origins?: string[];
      }) => Promise.resolve([...permissions, ...origins].every((name) => granted.has(name))),
      onAdded: event(),
      onRemoved: event(),
    },
    alarms: {
      create: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve(true)),
      onAlarm: event(),
    },
    windows: {
      create: vi.fn((_data: unknown) => Promise.resolve({ id: 3, tabs: [{ id: RUN_TAB }] })),
      remove: vi.fn((_id: number) => Promise.resolve()),
      getLastFocused: () => Promise.resolve({ left: 0, top: 0, width: 1000, height: 800 }),
    },
    tabs: {
      create: vi.fn(() => Promise.resolve({ id: RUN_TAB })),
      remove: vi.fn(() => Promise.resolve()),
      query: () => Promise.resolve([]),
      sendMessage: vi.fn(() => new Promise(() => {})),
      onRemoved: tabsOnRemoved,
    },
  };
  return { chrome, ports, badge, sessionArea, local, granted };
}

/** The tab Mode B opens (inside window 3); USER_TAB is the user browsing X. */
const RUN_TAB = 7;
const USER_TAB = 1;

let fake: ReturnType<typeof fakeChrome>;

async function setCapture(enabled: boolean, collectTarget = 250): Promise<void> {
  await fake.chrome.storage.local.set({
    "nmc-settings": { devCaptureEnabled: enabled, collectTarget },
  });
}

function captureTimeline(tabId = USER_TAB, status = 200): void {
  fake.chrome.runtime.onMessage.emit(
    { kind: "timeline-capture", operation: "HomeTimeline", bodyText: response1, status },
    { id: "test", tab: { id: tabId } },
  );
}

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await fake.chrome.storage.local.set({ "nmc-settings": settings });
}

function modeBCommand(command: "start" | "stop", sender: object = { id: "test" }): void {
  fake.chrome.runtime.onMessage.emit({ kind: "mode-b-command", command }, sender);
}

function lastRun(): Record<string, unknown> | undefined {
  return fake.local.get("nmc-mode-b-last-run") as Record<string, unknown> | undefined;
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

/** The port the worker currently uses (a new one per counting session). */
function currentPort(): FakePort {
  const port = fake.ports.at(-1);
  if (!port) throw new Error("no native port opened");
  return port;
}

function postedTypes(port: FakePort | undefined): string[] {
  return port?.posted.map((m) => m.type) ?? [];
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("background worker", () => {
  it("shows its own distinct count while developer capture is off", async () => {
    captureTimeline();
    await settle();
    expect(fake.badge.text).toBe("4");
    expect(postedTypes(fake.ports[0])).toEqual(["ping", "post-batch"]);
  });

  it("shows the host's count while developer capture is on and skips its own counting", async () => {
    await setCapture(true);
    await settle();
    captureTimeline();
    await settle();
    const port = currentPort();
    expect(postedTypes(port)).toEqual(["ping", "raw-capture", "post-batch"]);
    expect(fake.badge.text).toBe("");
    expect(fake.sessionArea.size).toBe(0); // host is the single source

    port?.onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(17) });
    await settle();
    expect(fake.badge.text).toBe("17");
  });

  it("forwards Reddit captures only with developer capture on, apart from X's counts", async () => {
    // Made-up shreddit markup, no real data.
    const redditCapture = {
      kind: "reddit-capture",
      operation: "dom-initial",
      bodyText: '<shreddit-post id="t3_1"></shreddit-post>',
    };
    fake.chrome.runtime.onMessage.emit(redditCapture, { id: "test", tab: { id: USER_TAB } });
    await settle();
    expect(postedTypes(currentPort())).toEqual(["ping"]);

    await setCapture(true);
    await settle();
    fake.chrome.runtime.onMessage.emit(redditCapture, { id: "test", tab: { id: USER_TAB } });
    await settle();
    const port = currentPort();
    expect(port.posted).toEqual([
      { type: "ping" },
      expect.objectContaining({
        type: "raw-capture",
        source: "reddit",
        operation: "dom-initial",
        bodyText: redditCapture.bodyText,
      }),
    ]);
    expect(fake.sessionArea.size).toBe(0);

    port.onMessage.emit({
      type: "capture-accepted",
      source: "reddit",
      sequence: 1,
      stats: stats(5),
    });
    await settle();
    expect(fake.badge.text).toBe("");
    expect(fake.chrome.notifications.create).not.toHaveBeenCalled();
  });

  it("forwards Instagram captures only with developer capture on, apart from X's counts", async () => {
    // Made-up body, no real data.
    const instagramCapture = {
      kind: "instagram-capture",
      operation: "ssr",
      bodyText: '{"xdt_api__v1__feed__timeline__connection":{"edges":[]}}',
    };
    fake.chrome.runtime.onMessage.emit(instagramCapture, { id: "test", tab: { id: USER_TAB } });
    await settle();
    expect(postedTypes(currentPort())).toEqual(["ping"]);

    await setCapture(true);
    await settle();
    fake.chrome.runtime.onMessage.emit(instagramCapture, { id: "test", tab: { id: USER_TAB } });
    await settle();
    const port = currentPort();
    expect(port.posted).toEqual([
      { type: "ping" },
      expect.objectContaining({
        type: "raw-capture",
        source: "instagram",
        operation: "ssr",
        bodyText: instagramCapture.bodyText,
      }),
    ]);

    port.onMessage.emit({
      type: "capture-accepted",
      source: "instagram",
      sequence: 1,
      stats: stats(5),
    });
    await settle();
    expect(fake.badge.text).toBe("");
    expect(fake.chrome.notifications.create).not.toHaveBeenCalled();
  });

  it("turns the badge green at the target and back to default on reset", async () => {
    await setCapture(true, 10);
    await settle();
    captureTimeline();
    await settle();
    currentPort().onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(10) });
    await settle();
    expect(fake.badge.color).toBe("#137333");
    expect(fake.chrome.notifications.create).toHaveBeenCalledTimes(1);

    await setCapture(false, 10);
    await settle();
    expect(fake.badge.text).toBe("");
    expect(fake.badge.color).toBe("#5f6368");
  });

  it("resets the session and closes the port once its host has answered", async () => {
    captureTimeline();
    await settle();
    expect(fake.badge.text).toBe("4");
    const oldPort = fake.ports[0];

    await setCapture(true);
    await settle();
    // Ping and batch are still unanswered: closing now could lose the batch.
    expect(oldPort?.disconnect).not.toHaveBeenCalled();
    expect(fake.badge.text).toBe("");
    expect(fake.sessionArea.size).toBe(0);

    oldPort?.onMessage.emit({ type: "pong" });
    // A late reply from the old port must not repaint the fresh badge.
    oldPort?.onMessage.emit({ type: "capture-accepted", sequence: 9, stats: stats(99) });
    await settle();
    expect(fake.badge.text).toBe("");
    expect(oldPort?.disconnect).toHaveBeenCalledTimes(1);

    // The new session's port (and desktop link) opens right away.
    expect(fake.ports).toHaveLength(2);
    captureTimeline();
    await settle();
    expect(fake.ports).toHaveLength(2);
    expect(postedTypes(currentPort())).toEqual(["ping", "raw-capture", "post-batch"]);
  });

  it("syncs the managed settings to the desktop once per browser start", async () => {
    await setSettings({ maxClickbait: 5, devCaptureEnabled: true });
    expect(fake.chrome.runtime.sendNativeMessage).not.toHaveBeenCalled();
    fake.chrome.runtime.onStartup.emit();
    await settle();
    expect(fake.chrome.runtime.sendNativeMessage).toHaveBeenCalledTimes(1);
    const [host, message] = fake.chrome.runtime.sendNativeMessage.mock.calls[0] ?? [];
    expect(host).toBe("io.github.hakunokina.no_more_clickbait");
    expect(message).toMatchObject({
      type: "settings-sync",
      settings: { maxClickbait: 5, devCaptureEnabled: true },
      // Saved before stamps existed: older than any stamped save.
      stamp: { updatedAt: "1970-01-01T00:00:00.000Z" },
    });
    // Deprecated fields stay in the extension.
    expect(message).not.toHaveProperty("settings.modeBTarget");
  });

  it("reports its settings each time the desktop link comes up", async () => {
    const stamp = { updatedAt: "2026-10-15T10:00:00.000Z", source: "extension" };
    await fake.chrome.storage.local.set({
      "nmc-settings": { maxClickbait: 4 },
      "nmc-settings-stamp": stamp,
    });
    await settle();
    const port = currentPort();
    const up = { type: "link-status", desktopConnected: true, extensionConnected: true };
    port.onMessage.emit({ ...up, desktopConnected: false });
    port.onMessage.emit(up);
    await settle();
    port.onMessage.emit(up);
    await settle();
    const reports = () => port.posted.filter((message) => message.type === "settings-sync");
    expect(reports()).toEqual([
      { type: "settings-sync", settings: expect.objectContaining({ maxClickbait: 4 }), stamp },
    ]);
    port.onMessage.emit({ ...up, desktopConnected: false });
    await settle();
    port.onMessage.emit(up);
    await settle();
    expect(reports()).toHaveLength(2);
  });

  it("reports an Options save to the linked desktop, but not a desktop push or while unlinked", async () => {
    await settle();
    const port = currentPort();
    const reports = () => port.posted.filter((message) => message.type === "settings-sync");
    const optionsSave = async (maxClickbait: number, updatedAt: string) => {
      await fake.chrome.storage.local.set({
        "nmc-settings": { maxClickbait },
        "nmc-settings-stamp": { updatedAt, source: "extension" },
      });
      await settle();
    };
    // Not linked to the desktop: the one-shot sync covers settings.json.
    await optionsSave(4, "2026-10-15T10:00:00.000Z");
    expect(reports()).toHaveLength(0);

    port.onMessage.emit({
      type: "link-status",
      desktopConnected: true,
      extensionConnected: true,
    });
    await settle();
    expect(reports()).toHaveLength(1);
    const stamp = { updatedAt: "2026-10-15T10:01:00.000Z", source: "extension" };
    await optionsSave(6, stamp.updatedAt);
    expect(reports()).toHaveLength(2);
    expect(reports().at(-1)).toEqual({
      type: "settings-sync",
      settings: expect.objectContaining({ maxClickbait: 6 }),
      stamp,
    });

    // A desktop push is answered by its push-result, not reported again.
    await fake.chrome.storage.local.set({
      "nmc-settings-stamp": { updatedAt: "2026-10-15T10:02:00.000Z", source: "desktop" },
    });
    await settle();
    expect(reports()).toHaveLength(2);
  });

  it("applies a desktop push and answers on the port; the push itself needs no answer", async () => {
    await setSettings({ maxClickbait: 7 });
    await settle();
    const port = currentPort();
    const stamp = { updatedAt: "2026-10-15T10:05:00.000Z", source: "desktop" };
    const settings = {
      collectTarget: 300,
      timelineSize: 40,
      maxClickbait: 3,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
      modeBEnabled: true,
      modeBStrategy: "offscreen-window",
      modeBPacing: "fast",
      devCaptureEnabled: false,
      uiLanguage: "tr",
    };
    port.onMessage.emit({ type: "settings-push", settings, stamp });
    await settle();
    expect(fake.local.get("nmc-settings")).toMatchObject(settings);
    expect(fake.local.get("nmc-settings-stamp")).toEqual(stamp);
    expect(port.posted.at(-1)).toEqual({
      type: "settings-push-result",
      outcome: "applied",
      settings,
      stamp,
    });
  });

  it("keeps Mode B off when a desktop push turns it on without the permission", async () => {
    fake.granted.delete("alarms");
    await settle();
    currentPort().onMessage.emit({
      type: "settings-push",
      settings: {
        collectTarget: 250,
        timelineSize: 50,
        maxClickbait: 7,
        minReadValue: 2,
        minReadForVerify: 4,
        maxVerifications: 20,
        verifyEnabled: true,
        modeBEnabled: true,
        modeBStrategy: "minimized-window",
        modeBPacing: "normal",
        devCaptureEnabled: false,
      },
      stamp: { updatedAt: "2026-10-15T10:05:00.000Z", source: "desktop" },
    });
    await settle();
    expect(fake.local.get("nmc-settings")).toMatchObject({ modeBEnabled: false });
    expect(currentPort().posted.at(-1)).toMatchObject({
      type: "settings-push-result",
      modeBPermissionMissing: true,
    });
  });

  it("warns instead of failing when the host is missing at startup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.chrome.runtime.sendNativeMessage.mockRejectedValueOnce(
      new Error("Specified native messaging host not found."),
    );
    fake.chrome.runtime.onInstalled.emit({ reason: "install" });
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
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
    currentPort().onMessage.emit({ type: "capture-accepted", sequence: 1, stats: oldStats });
    await settle();
    expect(fake.badge.text).toBe("?");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pnpm build"));
    expect(fake.chrome.notifications.create).not.toHaveBeenCalled();
  });
});

describe("desktop link in the background worker", () => {
  const modeBOn = {
    modeBEnabled: true,
    collectTarget: 4,
    modeBStrategy: "minimized-window",
  };

  it("stores the desktop's language, and nothing it cannot show", async () => {
    currentPort().onMessage.emit({ type: "ui-lang", lang: "tr" });
    await settle();
    expect(fake.local.get("nmc-desktop-lang")).toBe("tr");
    for (const lang of ["de", "system", 1, undefined]) {
      currentPort().onMessage.emit({ type: "ui-lang", lang });
    }
    await settle();
    expect(fake.local.get("nmc-desktop-lang")).toBe("tr");
    currentPort().onMessage.emit({ type: "ui-lang", lang: "en" });
    await settle();
    expect(fake.local.get("nmc-desktop-lang")).toBe("en");
  });

  it("opens the long-lived host port with a ping at startup", () => {
    expect(fake.ports).toHaveLength(1);
    expect(postedTypes(fake.ports[0])).toEqual(["ping"]);
  });

  it("reopens the port with backoff when the host goes away", async () => {
    vi.useFakeTimers();
    try {
      fake.ports[0]?.onDisconnect.emit();
      expect(fake.ports).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.ports).toHaveLength(2);
      fake.ports[1]?.onDisconnect.emit();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.ports).toHaveLength(2); // second wait is 10 s
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.ports).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the desktop's start-collection with the Mode B off instruction", async () => {
    await setSettings({ collectTarget: 300 });
    await settle();
    currentPort().onMessage.emit({ type: "start-collection" });
    await settle();
    expect(currentPort().posted.at(-1)).toEqual({
      type: "collection-start-result",
      outcome: "mode-b-off",
      target: 300,
    });
    expect(fake.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("starts Mode B for the desktop and completes the collection at the target", async () => {
    await setSettings(modeBOn);
    await settle();
    const linkPort = currentPort();
    linkPort.onMessage.emit({ type: "start-collection", target: 4 });
    await settle();
    expect(linkPort.posted.at(-1)).toEqual({
      type: "collection-start-result",
      outcome: "started",
      target: 4,
    });
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);

    const runPort = currentPort();
    expect(runPort).not.toBe(linkPort); // the run has its own host session
    captureTimeline(RUN_TAB);
    await settle();
    expect(runPort.posted.at(-1)).toEqual({
      type: "collection-complete",
      mode: "B",
      reason: "target-reached",
      uniquePostCount: 4,
      responseCount: 1,
      target: 4,
    });
    expect(runPort.posted).toContainEqual({
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 4,
      target: 4,
    });
    expect(postedTypes(runPort)).toEqual([
      "ping",
      "post-batch",
      "collection-progress",
      "collection-complete",
    ]);
    expect(currentPort()).not.toBe(runPort);
    expect(fake.badge.text).toBe("4");

    // The run's port closes only once its host answered all four messages.
    for (const reply of ["pong", "batch-accepted", "collection-recorded"]) {
      runPort.onMessage.emit({ type: reply, postCount: 4 });
    }
    runPort.onMessage.emit({
      type: "link-status",
      desktopConnected: true,
      extensionConnected: true,
    });
    await settle();
    expect(runPort.disconnect).not.toHaveBeenCalled();
    runPort.onMessage.emit({ type: "collection-recorded" });
    await settle();
    expect(runPort.disconnect).toHaveBeenCalledTimes(1);
  });

  it("says busy while a run is going", async () => {
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    modeBCommand("start");
    await settle();
    currentPort().onMessage.emit({ type: "start-collection" });
    await settle();
    expect(currentPort().posted.at(-1)).toMatchObject({ outcome: "busy" });
  });

  it("ends a cancelled run's collection with its reason (the desktop builds nothing)", async () => {
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    modeBCommand("start");
    await settle();
    modeBCommand("stop");
    await settle();
    expect(lastRun()).toMatchObject({ stopReason: "cancelled" });
    expect(fake.ports.flatMap((port) => port.posted)).toContainEqual(
      expect.objectContaining({ type: "collection-complete", mode: "B", reason: "cancelled" }),
    );
  });

  it("cancels the desktop's collection on its stop-collection push", async () => {
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    const linkPort = currentPort();
    linkPort.onMessage.emit({ type: "start-collection" });
    linkPort.onMessage.emit({ type: "stop-collection" }); // before the start finished
    await settle();
    expect(lastRun()).toMatchObject({ stopReason: "cancelled" });
    expect(fake.ports.flatMap((port) => port.posted)).toContainEqual(
      expect.objectContaining({ type: "collection-complete", mode: "B", reason: "cancelled" }),
    );
  });

  it("completes a Mode A collection once the user's own scrolling reaches the target", async () => {
    await setSettings({ collectTarget: 4 });
    await settle();
    const port = currentPort();
    captureTimeline();
    await settle();
    expect(port.posted.at(-1)).toEqual({
      type: "collection-complete",
      mode: "A",
      reason: "target-reached",
      uniquePostCount: 4,
      responseCount: 0,
      target: 4,
    });
    // The batch that reached the target went first, into the same session.
    expect(postedTypes(port)).toEqual(["ping", "post-batch", "collection-complete"]);
    expect(currentPort()).not.toBe(port);
    expect(fake.badge).toEqual({ text: "4", color: "#137333" });

    // A new session counts from zero: the same 4 posts complete it again.
    const second = currentPort();
    captureTimeline();
    await settle();
    expect(postedTypes(second)).toEqual(["ping", "post-batch", "collection-complete"]);
  });

  it("reports the count as it stands when the queued Mode A completion runs", async () => {
    await setSettings({ collectTarget: 4 });
    await settle();
    const port = currentPort();
    // The first response reaches the target (4); the second, arriving
    // before the queued completion runs, adds one more post (5).
    captureTimeline();
    fake.chrome.runtime.onMessage.emit(
      { kind: "timeline-capture", operation: "HomeTimeline", bodyText: response2, status: 200 },
      { id: "test", tab: { id: USER_TAB } },
    );
    await settle();
    expect(postedTypes(port)).toEqual([
      "ping",
      "post-batch",
      "post-batch",
      "collection-complete",
    ]);
    expect(port.posted.at(-1)).toMatchObject({
      type: "collection-complete",
      uniquePostCount: 5,
    });
  });

  it("leaves developer capture sessions alone at the target", async () => {
    await setCapture(true, 4);
    await settle();
    captureTimeline();
    await settle();
    currentPort().onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(4) });
    await settle();
    expect(fake.ports.flatMap((port) => postedTypes(port))).not.toContain(
      "collection-complete",
    );
  });
});

describe("Mode B in the background worker", () => {
  // The run's target is collectTarget; a stale deprecated modeBTarget is ignored.
  const modeBOn = {
    modeBEnabled: true,
    modeBTarget: 100,
    collectTarget: 4,
    modeBStrategy: "minimized-window",
  };

  it("opens a minimized window, counts its posts and closes it at the target", async () => {
    await setSettings(modeBOn);
    await settle();
    modeBCommand("start");
    await settle();
    expect(fake.chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://x.com/home",
        state: "minimized",
        focused: false,
      }),
    );
    expect(fake.chrome.alarms.create).toHaveBeenCalledWith("nmc-mode-b-watchdog", {
      periodInMinutes: 0.5,
    });
    expect(fake.sessionArea.get("nmc-mode-b-run")).toMatchObject({ tabId: RUN_TAB });

    captureTimeline(RUN_TAB);
    await settle();
    expect(fake.badge.text).toBe("4");
    expect(fake.chrome.windows.remove).toHaveBeenCalledWith(3);
    expect(lastRun()).toMatchObject({
      counter: "extension",
      stopReason: "target-reached",
      uniquePostCount: 4,
      responseCount: 1,
    });
    expect(fake.badge.color).toBe("#137333");
    expect(fake.chrome.notifications.create).toHaveBeenCalledWith(
      "nmc-mode-b-finished",
      expect.objectContaining({ title: expect.stringContaining("finished") }),
    );
    // Extension counter: nothing about the run goes to the host.
    expect(fake.ports.flatMap((port) => port.posted.map((m) => m.type))).not.toContain(
      "mode-b-run",
    );
  });

  it("counts with the host and records the run in its session when developer capture is on", async () => {
    await setSettings({ ...modeBOn, devCaptureEnabled: true });
    await settle();
    modeBCommand("start");
    await settle();
    captureTimeline(RUN_TAB);
    await settle();
    const port = currentPort();
    port.onMessage.emit({ type: "capture-accepted", sequence: 1, stats: stats(4) });
    await settle();
    expect(lastRun()).toMatchObject({ counter: "host", stopReason: "target-reached" });
    expect(postedTypes(port)).toEqual([
      "ping",
      "raw-capture",
      "post-batch",
      "collection-progress",
      "mode-b-run",
      "collection-complete",
    ]);
    // The finished run's session is closed; the next posts go to a new one.
    expect(currentPort()).not.toBe(port);
  });

  it("stops on a rate-limited response from the run's tab", async () => {
    // The user's own browsing feeds the same count, so keep the target out of reach.
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    modeBCommand("start");
    await settle();
    captureTimeline(USER_TAB, 429); // the user's own tab does not stop the run
    await settle();
    expect(lastRun()).toBeUndefined();
    captureTimeline(RUN_TAB, 429);
    await settle();
    expect(lastRun()).toMatchObject({ stopReason: "rate-limited" });
  });

  it("refuses to start without the optional permission", async () => {
    fake.granted.clear();
    await setSettings(modeBOn);
    await settle();
    modeBCommand("start");
    await settle();
    expect(fake.chrome.windows.create).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ stopReason: "permission-missing", scrollCount: 0 });
  });

  it("ignores start while Mode B is off or when a content script asks", async () => {
    modeBCommand("start");
    await settle();
    await setSettings(modeBOn);
    await settle();
    modeBCommand("start", { id: "test", tab: { id: USER_TAB } });
    await settle();
    expect(fake.chrome.windows.create).not.toHaveBeenCalled();
  });

  it("ends the run when Mode B is switched off, and on stop", async () => {
    await setSettings(modeBOn);
    await settle();
    modeBCommand("start");
    await settle();
    await setSettings({ ...modeBOn, modeBEnabled: false });
    await settle();
    expect(fake.chrome.windows.remove).toHaveBeenCalledWith(3);
    expect(lastRun()).toMatchObject({ stopReason: "settings-changed" });

    await setSettings(modeBOn);
    await settle();
    modeBCommand("start");
    await settle();
    modeBCommand("stop");
    await settle();
    expect(lastRun()).toMatchObject({ stopReason: "cancelled" });
  });

  it("notices when the user closes the run's tab", async () => {
    await setSettings(modeBOn);
    await settle();
    modeBCommand("start");
    await settle();
    fake.chrome.tabs.onRemoved.emit(RUN_TAB);
    await settle();
    expect(lastRun()).toMatchObject({ stopReason: "tab-closed" });
    expect(fake.chrome.windows.remove).not.toHaveBeenCalled();
  });

  it("closes the session of a start that threw, and the next start runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    const set = fake.chrome.storage.session.set;
    fake.chrome.storage.session.set = (items) =>
      "nmc-mode-b-run" in items ? Promise.reject(new Error("quota")) : set(items);
    modeBCommand("start");
    await settle();
    // Closing the failed start's session opened the next one's port last.
    const port = fake.ports.at(-2);
    expect(port?.posted).toContainEqual(
      expect.objectContaining({
        type: "collection-complete",
        mode: "B",
        reason: "failed-to-open",
      }),
    );
    expect(lastRun()).toMatchObject({ stopReason: "failed-to-open", error: "quota" });
    expect(fake.chrome.windows.remove).toHaveBeenCalledWith(3);

    fake.chrome.storage.session.set = set;
    modeBCommand("start");
    await settle();
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(fake.sessionArea.get("nmc-mode-b-run")).toMatchObject({ tabId: RUN_TAB });
  });

  it("keeps a failed start's own error when closing its session fails too", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await setSettings({ ...modeBOn, collectTarget: 100 });
    await settle();
    const sessionSet = fake.chrome.storage.session.set;
    fake.chrome.storage.session.set = (items) =>
      "nmc-mode-b-run" in items ? Promise.reject(new Error("quota")) : sessionSet(items);
    const localSet = fake.chrome.storage.local.set;
    fake.chrome.storage.local.set = (items) =>
      "nmc-mode-b-last-run" in items ? Promise.reject(new Error("disk")) : localSet(items);
    modeBCommand("start");
    await settle();
    const logged = errors.mock.calls.map((call) => String(call[0]));
    expect(logged).toContainEqual(
      expect.stringContaining("Mode B command failed: Error: quota"),
    );
    expect(logged).toContainEqual(expect.stringContaining("disk"));
  });
});

describe("custom sites in the background worker's collections", () => {
  const FEED = "https://news.example.invalid/world/feed.xml";
  const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>World</title>
    <item><title>Feed one</title><link>https://news.example.invalid/world/f1</link></item>
    <item><title>Feed two</title><link>https://news.example.invalid/world/f2</link></item>
    <item><title>Feed three</title><link>https://news.example.invalid/world/f3</link></item>
  </channel></rss>`;

  async function storeFeedSite(): Promise<void> {
    fake.granted.add("https://news.example.invalid/*");
    await fake.chrome.storage.local.set({
      "nmc.siteRules": {
        "news.example.invalid/world": {
          nmcRule: 1,
          id: "news.example.invalid/world",
          name: "World",
          url: "https://news.example.invalid/world",
          match: ["news.example.invalid/world/*"],
          collect: { method: "rss", rssUrl: FEED },
          origin: "manual",
          createdAt: "2026-10-15T10:00:00.000Z",
          updatedAt: "2026-10-15T10:00:00.000Z",
        },
      },
      "nmc.siteState.news.example.invalid/world": { enabled: true, permissionGranted: true },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === FEED
            ? new Response(FEED_XML, {
                status: 200,
                headers: { "content-type": "application/rss+xml" },
              })
            : new Response("", { status: 404 }),
        ),
      ),
    );
  }

  it("collects enabled sites when Mode A reaches its target; completion waits and reports them", async () => {
    await storeFeedSite();
    await setSettings({ collectTarget: 4 });
    await settle();
    const port = currentPort();
    captureTimeline();
    await settle();
    await settle();
    // X's batch first, then the site's items (never counted for X), then the completion.
    expect(postedTypes(port)).toEqual([
      "ping",
      "post-batch",
      "feed-batch",
      "collection-complete",
    ]);
    const batch = port.posted[2] as unknown as { batch: { siteId: string; items: unknown[] } };
    expect(batch.batch.siteId).toBe("news.example.invalid/world");
    expect(batch.batch.items).toHaveLength(3);
    expect(port.posted.at(-1)).toEqual({
      type: "collection-complete",
      mode: "A",
      reason: "target-reached",
      uniquePostCount: 4,
      responseCount: 0,
      target: 4,
      sites: [
        {
          siteId: "news.example.invalid/world",
          name: "World",
          method: "rss",
          status: "ok",
          itemCount: 3,
        },
      ],
    });
    expect(fake.badge.text).toBe("4");
    const state = fake.local.get("nmc.siteState.news.example.invalid/world") as {
      lastItemCount?: number;
    };
    expect(state.lastItemCount).toBe(3);
  });

  it("still reports the sites when the worker restarted during a Mode B run", async () => {
    await storeFeedSite();
    await setSettings({
      modeBEnabled: true,
      collectTarget: 100,
      modeBStrategy: "minimized-window",
    });
    await settle();
    modeBCommand("start");
    await settle();
    // The service worker is stopped and started again mid-run: memory is
    // gone, storage stays.
    const before = fake;
    fake = fakeChrome();
    for (const [key, value] of before.local) fake.local.set(key, value);
    for (const [key, value] of before.sessionArea) fake.sessionArea.set(key, value);
    for (const name of before.granted) fake.granted.add(name);
    // The restarted worker resumes the run with a step at 0 ms. This fake
    // page never answers a step, so a step that fired would hold the run's
    // queue until its 5 s timeout and the stop behind it: held, the timer
    // leaves the stop to end the run, whichever way the event loop turns.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("chrome", fake.chrome);
    vi.resetModules();
    await import("./background.js");
    await settle();
    modeBCommand("stop");
    await settle();
    expect(fake.ports.flatMap((port) => port.posted)).toContainEqual(
      expect.objectContaining({
        type: "collection-complete",
        reason: "cancelled",
        sites: [
          expect.objectContaining({ siteId: "news.example.invalid/world", itemCount: 3 }),
        ],
      }),
    );
  });

  it("waits out and drops the site run of a Mode B start that threw", async () => {
    await storeFeedSite();
    let answerFeed = (): void => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answerFeed = () =>
              resolve(
                new Response(FEED_XML, {
                  status: 200,
                  headers: { "content-type": "application/rss+xml" },
                }),
              );
          }),
      ),
    );
    await setSettings({
      modeBEnabled: true,
      collectTarget: 100,
      modeBStrategy: "minimized-window",
    });
    await settle();
    const set = fake.chrome.storage.session.set;
    fake.chrome.storage.session.set = (items) =>
      "nmc-mode-b-run" in items ? Promise.reject(new Error("quota")) : set(items);
    modeBCommand("start");
    await settle();
    const port = currentPort();
    answerFeed();
    await settle();
    // Its items went to the session the failed start opened; no outcome
    // is left over for the next collection to report.
    expect(postedTypes(port)).toContain("feed-batch");
    expect(fake.sessionArea.has("nmc.siteRunOutcomes")).toBe(false);
  });

  it("leaves completion as before when no site is set up", async () => {
    await setSettings({ collectTarget: 4 });
    await settle();
    const port = currentPort();
    captureTimeline();
    await settle();
    expect(port.posted.at(-1)).not.toHaveProperty("sites");
  });

  it("refuses a picker save from a tab it never opened", async () => {
    const sendResponse = vi.fn();
    fake.chrome.runtime.onMessage.listeners.forEach((listener) =>
      listener(
        { kind: "site-picker-save", rule: {}, foundCount: 1 },
        { id: "test", tab: { id: 99 } },
        sendResponse,
      ),
    );
    await settle();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, message: "not allowed" });
    expect(fake.local.get("nmc.siteRules")).toBeUndefined();
  });

  function ask(message: unknown, sender: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const sendResponse = vi.fn();
    fake.chrome.runtime.onMessage.listeners.forEach((listener) =>
      listener(message, sender, sendResponse),
    );
    return sendResponse;
  }

  it("answers Options, which always runs in a tab (options_page)", async () => {
    // What Chrome reports for an options_page: a tab, and the extension's own URL.
    const options = {
      id: "test",
      url: "chrome-extension://test/options.html#sites",
      tab: { id: 12, url: "chrome-extension://test/options.html#sites" },
    };
    const probe = ask({ kind: "site-probe", rule: {} }, options);
    const visible = ask(
      { kind: "site-collect-visible", id: "missing.example.invalid" },
      options,
    );
    await settle();
    expect(probe).toHaveBeenCalledWith({ ok: false, count: 0, message: "invalid rule" });
    expect(visible).toHaveBeenCalledWith({ ok: false, count: 0, message: "rule not found" });
  });

  it("refuses the extension-page commands from a web page's content script", async () => {
    const page = {
      id: "test",
      url: "https://news.example.invalid/world",
      tab: { id: 12, url: "https://news.example.invalid/world" },
    };
    const open = ask(
      { kind: "site-picker-open", target: { url: "https://a.example.invalid/", pattern: "a" } },
      page,
    );
    const probe = ask({ kind: "site-probe", rule: {} }, page);
    await settle();
    expect(open).toHaveBeenCalledWith({ ok: false, message: "not allowed" });
    expect(probe).toHaveBeenCalledWith({ ok: false, message: "not allowed" });
    expect(fake.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("moves states from the old shared map to one key per site", async () => {
    // A worker starting over storage written before per-site keys.
    fake = fakeChrome();
    vi.stubGlobal("chrome", fake.chrome);
    fake.local.set("nmc.siteStates", {
      "news.example.invalid/world": { enabled: false, permissionGranted: true },
    });
    vi.resetModules();
    await import("./background.js");
    await settle();
    expect(fake.local.has("nmc.siteStates")).toBe(false);
    expect(fake.local.get("nmc.siteState.news.example.invalid/world")).toMatchObject({
      enabled: false,
    });
  });
});
