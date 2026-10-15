import {
  bridgeMessageByteLength,
  BridgeReplySchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseHomeTimeline,
  type BridgeMessage,
  type CaptureStats,
  type CollectionComplete,
  type CollectionStartResult,
  type ModeBRunSummary,
  type PostBatch,
  type Settings,
} from "@nmc/core";
import { CaptureSession } from "./capture-session.js";
import {
  isModeBCommandMessage,
  isWorkerCaptureMessage,
  type WorkerCaptureMessage,
} from "./messages.js";
import {
  describeStopReason,
  isRateLimited,
  MODE_B_LAST_RUN_KEY,
  MODE_B_PERMISSIONS,
  ModeBRunner,
  refusedRun,
  type ModeBBrowser,
  type ModeBStart,
} from "./mode-b.js";
import { loadSettings, SETTINGS_STORAGE_KEY } from "./settings.js";
import { NATIVE_HOST_NAME, sendNativeOnce, syncSettings } from "./settings-sync.js";

/**
 * Service worker: receives captured timeline responses, converts them
 * to Post batches and hands them to the desktop app through Native
 * Messaging (no TCP port; the browser launches the host process).
 *
 * Developer capture (opt-in, OFF by default): raw response bodies are
 * forwarded verbatim to the host, which stores them outside the repo
 * with a counts/times-only summary.
 *
 * Badge = distinct organic posts (no ads, no repeats across responses).
 * With developer capture ON the host's `uniquePostCount` is the single
 * source — it owns the dumps, so it is what was really captured — and
 * it alone drives the one-shot target notification (capture keeps
 * going). With capture OFF the worker's own session counter is shown.
 * Toggling developer capture starts a new counting session; replies
 * still in flight from the previous session's port are dropped.
 *
 * Host replies are validated: a host built from older sources (e.g. the
 * extension was reloaded but `pnpm build` + host re-register were
 * skipped) yields a "?" badge and a console warning, never "undefined".
 *
 * Mode B (opt-in, OFF by default; see README "Mode B and its risks"):
 * on a start command from the popup/options page, x.com/home opens on a
 * surface the user does not look at and is scrolled step by step until
 * enough distinct organic posts were counted (mode-b.ts). Each run
 * starts a fresh counting session — and so a fresh host capture folder,
 * whose summary.json also gets the run's counts. The count is the
 * host's with developer capture on, the worker's own otherwise; the run
 * summary says which (`counter`).
 */

export { NATIVE_HOST_NAME };

/*
 * Desktop link: the worker keeps one long-lived native port open (it
 * also keeps the worker alive, Chromium 105+). It opens with a `ping`,
 * on which the host links up with the desktop app; the desktop's
 * "Collect new timeline" arrives on it as `start-collection`. When the
 * collection target is reached the worker sends `collection-complete`
 * and starts a new counting session (= a new host session folder):
 * a Mode B run's timeline is built at once, a Mode A one (the user's own
 * scrolling) waits for the user's go in the desktop app.
 */
const LINK_RETRY_FIRST_MS = 5_000;
const LINK_RETRY_MAX_MS = 60_000;

const CAPTURE_NOTIFICATION_ID = "nmc-capture-target";
const MODE_B_NOTIFICATION_ID = "nmc-mode-b-finished";
const MODE_B_WATCHDOG_ALARM = "nmc-mode-b-watchdog";
const DEFAULT_BADGE_COLOR = "#5f6368";
const TARGET_BADGE_COLOR = "#137333";
const RUNNING_BADGE_COLOR = "#0b57d0";

let port: chrome.runtime.Port | null = null;
/** Bumped on every new counting session; work started under an older value is stale. */
let generation = 0;
const session = new CaptureSession(chrome.storage.session);
let linkRetryMs = LINK_RETRY_FIRST_MS;
let linkTimer: ReturnType<typeof setTimeout> | null = null;

function nativePort(): chrome.runtime.Port {
  if (port) return port;
  const opened = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  const portGeneration = generation;
  opened.onDisconnect.addListener(() => {
    if (port !== opened) return;
    port = null;
    // Host gone (crashed, not installed): reopen the link, backing off.
    scheduleDesktopLink();
  });
  opened.onMessage.addListener((reply: unknown) => {
    void handleReply(reply, portGeneration).catch((error: unknown) => {
      console.error(`[nmc] native host reply handling failed: ${String(error)}`);
    });
  });
  port = opened;
  opened.postMessage({ type: "ping" } satisfies BridgeMessage);
  return opened;
}

/** Keeps the long-lived host port — and with it the desktop link — open. */
function ensureDesktopLink(): void {
  try {
    nativePort();
  } catch {
    port = null;
    scheduleDesktopLink();
  }
}

function scheduleDesktopLink(): void {
  if (linkTimer) return;
  const delay = linkRetryMs;
  linkRetryMs = Math.min(delay * 2, LINK_RETRY_MAX_MS);
  linkTimer = setTimeout(() => {
    linkTimer = null;
    ensureDesktopLink();
  }, delay);
}

function sendToDesktop(message: BridgeMessage): boolean {
  try {
    nativePort().postMessage(message);
    return true;
  } catch {
    port = null;
    return false;
  }
}

async function updateBadge(count: number): Promise<void> {
  await chrome.action.setBadgeText({ text: count === 0 ? "" : String(count) });
}

async function handleReply(raw: unknown, replyGeneration: number): Promise<void> {
  const parsed = BridgeReplySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      "[nmc] native host reply has an unexpected shape — the host is probably older than the " +
        "extension: run `pnpm build`, re-register the host, then reload the extension",
    );
    const settings = await loadSettings().catch(() => null);
    if (settings?.devCaptureEnabled && replyGeneration === generation) {
      await chrome.action.setBadgeText({ text: "?" });
    }
    return;
  }
  const reply = parsed.data;
  linkRetryMs = LINK_RETRY_FIRST_MS;
  if (reply.type === "start-collection") {
    runCommand(() => startCollectionForDesktop(reply.target));
    return;
  }
  if (reply.type === "capture-accepted" || reply.type === "capture-rejected") {
    if (reply.type === "capture-rejected") {
      console.error(`[nmc] developer capture refused: ${reply.message}`);
    }
    await reflectCaptureStats(reply.stats, replyGeneration);
  } else if (reply.type === "error") {
    console.error(`[nmc] native host error: ${reply.message}`);
  }
}

async function reflectCaptureStats(
  stats: CaptureStats,
  replyGeneration: number,
): Promise<void> {
  const settings = await loadSettings().catch(() => null);
  if (!settings?.devCaptureEnabled || replyGeneration !== generation) return;
  await updateBadge(stats.uniquePostCount);
  await modeB.onCount(stats.uniquePostCount, "host");
  const reached = await session.reachedTarget(stats.uniquePostCount, settings.collectTarget);
  if (!reached || replyGeneration !== generation) return;
  await chrome.action.setBadgeBackgroundColor({ color: TARGET_BADGE_COLOR });
  try {
    await chrome.notifications.create(CAPTURE_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: "No More Clickbait — capture target reached",
      message:
        `${stats.uniquePostCount} distinct posts captured in ${stats.responseCount} timeline responses ` +
        `(target ${settings.collectTarget}). Capture continues; turn it off in Options to stop.`,
    });
  } catch {
    // Notification is best-effort; the badge already shows the state.
  }
}

/**
 * Forwards one raw body to the host for developer capture. Bodies that
 * would exceed the bridge frame ceiling are never chunked: they are
 * refused with a small counter message and an explicit error in the
 * service-worker console (mirrored in the session summary).
 */
function forwardDevCapture(message: WorkerCaptureMessage): void {
  const capturedAt = new Date().toISOString();
  const capture: BridgeMessage = {
    type: "raw-capture",
    operation: message.operation,
    capturedAt,
    bodyText: message.bodyText,
  };
  const framedBytes = bridgeMessageByteLength(capture);
  if (framedBytes > MAX_BRIDGE_MESSAGE_BYTES) {
    console.error(
      `[nmc] developer capture: ${message.operation} response is ${framedBytes} bytes framed, ` +
        `over the ${MAX_BRIDGE_MESSAGE_BYTES}-byte bridge ceiling — not captured`,
    );
    sendToDesktop({
      type: "capture-oversized",
      operation: message.operation,
      capturedAt,
      byteLength: framedBytes,
    });
    return;
  }
  if (!sendToDesktop(capture)) {
    console.error("[nmc] developer capture: native host unreachable — response not captured");
  }
}

async function handleCapture(
  message: WorkerCaptureMessage,
  tabId: number | undefined,
): Promise<void> {
  const captureGeneration = generation;
  const settings: Settings | null = await loadSettings().catch(() => null);
  if (settings?.devCaptureEnabled) {
    forwardDevCapture(message);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.bodyText);
  } catch {
    payload = undefined; // Not JSON (or truncated): nothing trustworthy to forward.
  }
  await modeB.onResponse(tabId, isRateLimited(message.status, payload));
  if (payload === undefined) return;

  const posts = parseHomeTimeline(payload);
  if (posts.length === 0) return;
  // Stored before counting: the count may complete the collection, and
  // the batch that reached the target belongs to it.
  const batch: PostBatch = {
    source: "x-home-timeline",
    capturedAt: new Date().toISOString(),
    posts,
  };
  sendToDesktop({ type: "post-batch", batch });

  // With capture ON the host's count is the single source (see top).
  if (!settings?.devCaptureEnabled) {
    const uniqueCount = await session.countPosts(posts);
    if (captureGeneration === generation) {
      await updateBadge(uniqueCount);
      const modeBRunning = (await modeB.current()) !== null;
      await modeB.onCount(uniqueCount, "extension");
      // Developer capture keeps its own semantics (one folder, capture
      // continues past the target), so Mode A completes only without it.
      if (!modeBRunning && settings) completeModeA(uniqueCount, settings, captureGeneration);
    }
  }
}

/**
 * Ends the current collection: the host closes its session folder and
 * tells the desktop app; the next posts start a new session.
 */
async function completeCollection(complete: Omit<CollectionComplete, "type">): Promise<void> {
  sendToDesktop({ type: "collection-complete", ...complete });
  await startNewCountingSession();
  // The finished count stays on the badge until the next post is counted.
  await updateBadge(complete.uniquePostCount);
}

/** Mode A: the user's own scrolling reached the collection target. */
function completeModeA(count: number, settings: Settings, countGeneration: number): void {
  if (count < settings.collectTarget || countGeneration !== generation) return;
  runCommand(async () => {
    // Another message may have completed this session already.
    if (countGeneration !== generation || (await modeB.current())) return;
    // Batches that arrived while this waited in the queue went to this
    // session too: report the count as it stands now.
    await completeCollection({
      mode: "A",
      reason: "target-reached",
      uniquePostCount: await session.uniqueCount(),
      // The extension counter does not track responses outside a Mode B run.
      responseCount: 0,
    });
    await chrome.action.setBadgeBackgroundColor({ color: TARGET_BADGE_COLOR });
  });
}

/**
 * Starts a new counting session. One host process == one capture
 * folder: closing the port ends it, so the next capture starts a fresh
 * host session too.
 */
async function startNewCountingSession(): Promise<void> {
  generation += 1;
  port?.disconnect();
  port = null;
  await session.reset();
  await updateBadge(0);
  await chrome.action.setBadgeBackgroundColor({ color: DEFAULT_BADGE_COLOR });
  ensureDesktopLink();
}

// --- Mode B ---------------------------------------------------------

const modeBBrowser: ModeBBrowser = {
  focusedWindowBounds: () => chrome.windows.getLastFocused(),
  async openWindow(create) {
    const created = await chrome.windows.create(create);
    const windowId = created?.id;
    if (windowId === undefined) throw new Error("the browser returned no window");
    const tabId = created?.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId }))[0]?.id;
    if (tabId === undefined) throw new Error("the new window has no tab");
    return { windowId, tabId };
  },
  async openTab(create) {
    const tab = await chrome.tabs.create(create);
    if (tab.id === undefined) throw new Error("the browser returned no tab");
    return { tabId: tab.id };
  },
  closeWindow: (windowId) => chrome.windows.remove(windowId),
  closeTab: (tabId) => chrome.tabs.remove(tabId),
  sendStep: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
};

const modeB = new ModeBRunner(modeBBrowser, chrome.storage.session, { onFinish: finishModeB });

/** `chrome.alarms` only exists once its optional permission is granted. */
function alarms(): typeof chrome.alarms | undefined {
  return (chrome as { alarms?: typeof chrome.alarms }).alarms;
}

let watchdogListening = false;

/** Re-arms a run's steps when the service worker was stopped mid-run. */
function listenToWatchdog(): void {
  const api = alarms();
  if (!api || watchdogListening) return;
  watchdogListening = true;
  api.onAlarm.addListener((alarm) => {
    if (alarm.name === MODE_B_WATCHDOG_ALARM) void modeB.resume();
  });
}

async function finishModeB(summary: ModeBRunSummary): Promise<void> {
  await chrome.storage.local.set({ [MODE_B_LAST_RUN_KEY]: summary });
  await alarms()?.clear(MODE_B_WATCHDOG_ALARM);
  // Recorded next to the run's dumps; a run that never started has none.
  if (summary.counter === "host" && summary.stopReason !== "permission-missing") {
    sendToDesktop({ type: "mode-b-run", run: summary });
  }
  // A run that started gets its timeline built — unless the user stopped
  // it (cancel, settings change): then its posts just stay collected.
  if (
    summary.stopReason !== "permission-missing" &&
    summary.stopReason !== "cancelled" &&
    summary.stopReason !== "settings-changed"
  ) {
    await completeCollection({
      mode: "B",
      reason: summary.stopReason,
      uniquePostCount: summary.uniquePostCount,
      responseCount: summary.responseCount,
    });
  }
  const reached = summary.stopReason === "target-reached";
  await chrome.action.setBadgeBackgroundColor({
    color: reached ? TARGET_BADGE_COLOR : DEFAULT_BADGE_COLOR,
  });
  try {
    await chrome.notifications.create(MODE_B_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: `No More Clickbait — collection ${reached ? "finished" : "stopped"}`,
      message:
        `${summary.uniquePostCount} of ${summary.target} distinct posts in ` +
        `${Math.round(summary.durationMs / 1000)} s (${summary.scrollCount} scrolls): ` +
        `${describeStopReason(summary.stopReason)}.`,
    });
  } catch {
    // Notification is best-effort; the options page shows the last run.
  }
}

async function startModeB(target?: number): Promise<void> {
  const settings = await loadSettings();
  if (!settings.modeBEnabled || (await modeB.current())) return;
  const start: ModeBStart = {
    strategy: settings.modeBStrategy,
    target: target ?? settings.collectTarget,
    counter: settings.devCaptureEnabled ? "host" : "extension",
  };
  if (!(await chrome.permissions.contains({ permissions: MODE_B_PERMISSIONS }))) {
    await finishModeB(refusedRun(start, Date.now(), "permission-missing"));
    return;
  }
  await startNewCountingSession();
  listenToWatchdog();
  await alarms()?.create(MODE_B_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  await chrome.action.setBadgeBackgroundColor({ color: RUNNING_BADGE_COLOR });
  await modeB.start(start);
}

/** The desktop app asked for a new timeline ("Collect new timeline"). */
async function startCollectionForDesktop(target: number | undefined): Promise<void> {
  const settings = await loadSettings();
  const goal = target ?? settings.collectTarget;
  const answer = (outcome: CollectionStartResult["outcome"]): void => {
    sendToDesktop({ type: "collection-start-result", outcome, target: goal });
  };
  if (!settings.modeBEnabled) return answer("mode-b-off");
  if (await modeB.current()) return answer("busy");
  if (!(await chrome.permissions.contains({ permissions: MODE_B_PERMISSIONS }))) {
    return answer("permission-missing");
  }
  // Answered on this port: starting the run opens a new host session.
  answer("started");
  await startModeB(goal);
}

/** Commands run one at a time: a double click must not reset a running count. */
let commands: Promise<unknown> = Promise.resolve();

function runCommand(work: () => Promise<void>): void {
  commands = commands.then(work).catch((error: unknown) => {
    console.error(`[nmc] Mode B command failed: ${String(error)}`);
  });
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (isModeBCommandMessage(message)) {
      // Only the extension's own pages (not content scripts) may start or stop a run.
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      runCommand(message.command === "start" ? startModeB : () => modeB.stop("cancelled"));
      return;
    }
    if (!isWorkerCaptureMessage(message)) return;
    const workerMessage: WorkerCaptureMessage = {
      kind: message.kind,
      operation: message.operation,
      bodyText: message.bodyText,
      ...(message.status === undefined ? {} : { status: message.status }),
    };
    void handleCapture(workerMessage, sender.tab?.id).catch((error: unknown) => {
      console.error(`[nmc] capture handling failed: ${String(error)}`);
    });
  },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void modeB.onTabRemoved(tabId);
});

function flag(value: unknown, key: "devCaptureEnabled" | "modeBEnabled"): boolean {
  return Boolean((value as Record<string, unknown> | undefined)?.[key]);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[SETTINGS_STORAGE_KEY];
  if (areaName !== "local" || !change) return;
  const captureToggled =
    flag(change.oldValue, "devCaptureEnabled") !== flag(change.newValue, "devCaptureEnabled");
  const modeBTurnedOff =
    flag(change.oldValue, "modeBEnabled") && !flag(change.newValue, "modeBEnabled");
  if (!captureToggled && !modeBTurnedOff) return;
  runCommand(async () => {
    // A run's counts belong to the session it ran in: end it first.
    await modeB.stop("settings-changed");
    if (captureToggled) await startNewCountingSession();
  });
});

/**
 * Once per browser start (and on install/update) the desktop gets the
 * current pipeline settings — not on every worker restart, each sync
 * starts a host process.
 */
async function syncSettingsAtStartup(): Promise<void> {
  const result = await syncSettings(await loadSettings(), sendNativeOnce);
  if (result.status !== "synced") {
    console.warn(
      `[nmc] settings not synced to the desktop (${result.status}): ${result.detail}`,
    );
  }
}

for (const startup of [chrome.runtime.onStartup, chrome.runtime.onInstalled]) {
  startup.addListener(() => {
    void syncSettingsAtStartup().catch((error: unknown) => {
      console.error(`[nmc] settings sync failed: ${String(error)}`);
    });
  });
}

// A restarted service worker picks up a run that was in progress.
listenToWatchdog();
void modeB.resume();
ensureDesktopLink();
