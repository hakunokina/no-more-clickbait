import {
  bridgeMessageByteLength,
  BridgeReplySchema,
  ManagedSettingsSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseHomeTimeline,
  SettingsStampSchema,
  type BridgeMessage,
  type CaptureSource,
  type CaptureStats,
  type CollectionComplete,
  type CollectionStartResult,
  type FeedBatch,
  type ModeBRunSummary,
  type PostBatch,
  type Settings,
  type SiteCollectOutcome,
  type SettingsStamp,
} from "@nmc/core";
import { CaptureSession } from "./capture-session.js";
import { installDevCaptureScripts } from "./dev-capture-scripts.js";
import {
  isModeBCommandMessage,
  isWorkerCaptureMessage,
  isWorkerInstagramCaptureMessage,
  isWorkerRedditCaptureMessage,
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
  type ModeBRun,
  type ModeBStart,
} from "./mode-b.js";
import { NativeChannel } from "./native-channel.js";
import {
  loadSettings,
  loadSettingsStamp,
  saveSettings,
  SETTINGS_STAMP_KEY,
  SETTINGS_STORAGE_KEY,
} from "./settings.js";
import {
  applySettingsPush,
  NATIVE_HOST_NAME,
  sendNativeOnce,
  syncSettings,
} from "./settings-sync.js";
import { collectSitesForCollection, installSiteWorker } from "./sites/site-worker.js";

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
 *
 * Reddit (developer capture only, no parsing yet): raw bodies and DOM
 * snapshots go to the host as `source: "reddit"`, into their own
 * folder; their counts stay in that folder's summary.json and never
 * touch the badge, Mode B or the X target.
 *
 * Instagram (developer capture only) works the same way, as
 * `source: "instagram"`: the document's embedded first feed page and the
 * home feed's `/graphql/query` responses; the host parses them for its
 * folder's counts only.
 */

export { NATIVE_HOST_NAME };

/*
 * Desktop link: the worker keeps one long-lived native port open (it
 * also keeps the worker alive, Chromium 105+). It opens with a `ping`,
 * on which the host links up with the desktop app; the desktop's
 * "Collect new timeline" arrives on it as `start-collection`, and a
 * Mode B run reports its count as `collection-progress`. When a
 * collection ends the worker sends `collection-complete` (Mode A: the
 * target was reached; Mode B: whatever ended the run, with its reason —
 * the desktop app decides whether to build) and starts a new counting
 * session (= a new host session folder; the old port closes only once
 * its host has answered everything, see native-channel.ts).
 *
 * Settings: whenever the desktop link comes up the worker reports its
 * settings (`settings-sync` with their stamp), so the desktop app shows
 * them and hands back a later change made there; a change in the
 * desktop app arrives as `settings-push` and is applied unless the
 * extension saved later (settings-sync.ts applySettingsPush).
 */
const LINK_RETRY_FIRST_MS = 5_000;
const LINK_RETRY_MAX_MS = 60_000;

const CAPTURE_NOTIFICATION_ID = "nmc-capture-target";
const MODE_B_NOTIFICATION_ID = "nmc-mode-b-finished";
const MODE_B_WATCHDOG_ALARM = "nmc-mode-b-watchdog";
const DEFAULT_BADGE_COLOR = "#5f6368";
const TARGET_BADGE_COLOR = "#137333";
const RUNNING_BADGE_COLOR = "#0b57d0";

/** Bumped on every new counting session; work started under an older value is stale. */
let generation = 0;
const session = new CaptureSession(chrome.storage.session);
let linkRetryMs = LINK_RETRY_FIRST_MS;
let linkTimer: ReturnType<typeof setTimeout> | null = null;
/** The current session's host is linked to the desktop app. */
let desktopLinked = false;

const channel = new NativeChannel(openNativePort);

function openNativePort(): chrome.runtime.Port {
  const opened = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  const portGeneration = generation;
  opened.onDisconnect.addListener(() => {
    // Host gone (crashed, not installed): reopen the link, backing off.
    if (channel.lost(opened)) scheduleDesktopLink();
  });
  opened.onMessage.addListener((reply: unknown) => {
    channel.received(opened, reply);
    void handleReply(reply, portGeneration).catch((error: unknown) => {
      console.error(`[nmc] native host reply handling failed: ${String(error)}`);
    });
  });
  return opened;
}

/** Keeps the long-lived host port — and with it the desktop link — open. */
function ensureDesktopLink(): void {
  try {
    channel.port();
  } catch {
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
  return channel.send(message);
}

/** The desktop app shows a Mode B run's count as it goes. */
function reportProgress(run: ModeBRun | null, count: number): void {
  if (!run) return;
  sendToDesktop({
    type: "collection-progress",
    mode: "B",
    uniquePostCount: count,
    target: Math.min(run.target, 10_000),
  });
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
  if (reply.type === "stop-collection") {
    // Queued behind a start still in flight, so it stops that run too.
    runCommand(() => modeB.stop("cancelled"));
    return;
  }
  if (reply.type === "settings-push") {
    applyPushedSettings(reply.settings, reply.stamp);
    return;
  }
  if (reply.type === "link-status") {
    if (replyGeneration !== generation) return;
    const cameUp = reply.desktopConnected && !desktopLinked;
    desktopLinked = reply.desktopConnected;
    if (cameUp) await reportSettingsToDesktop();
    return;
  }
  if (reply.type === "capture-accepted" || reply.type === "capture-rejected") {
    if (reply.type === "capture-rejected") {
      console.error(`[nmc] developer capture refused: ${reply.message}`);
    }
    // Only X's counts drive the badge, Mode B and the target.
    if ((reply.source ?? "x") !== "x") return;
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
  const run = await modeB.current();
  if (run?.counter === "host") reportProgress(run, stats.uniquePostCount);
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
function forwardDevCapture(
  message: { operation: string; bodyText: string },
  source?: CaptureSource,
): void {
  const capturedAt = new Date().toISOString();
  const capture: BridgeMessage = {
    type: "raw-capture",
    ...(source ? { source } : {}),
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
      ...(source ? { source } : {}),
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
      const run = await modeB.current();
      if (run?.counter === "extension") reportProgress(run, uniqueCount);
      await modeB.onCount(uniqueCount, "extension");
      // Developer capture keeps its own semantics (one folder, capture
      // continues past the target), so Mode A completes only without it.
      if (!run && settings) completeModeA(uniqueCount, settings, captureGeneration);
    }
  }
}

// --- Custom sites (Options › Sites) ------------------------------------
// Collected in parallel with X when a collection runs (leader decision
// #777): from the start of a Mode B run, or when Mode A reaches its
// target. Their items join the open host session as `feed-batch` (never
// the X counters); `collection-complete` waits for them (each site has
// its own time limit) and carries one outcome per site.

function sendFeedBatch(batch: FeedBatch): boolean {
  return sendToDesktop({ type: "feed-batch", batch });
}

let siteRun: Promise<SiteCollectOutcome[]> | null = null;

function startSiteRun(): void {
  siteRun ??= collectSitesForCollection(sendFeedBatch);
}

async function finishSiteRun(): Promise<SiteCollectOutcome[]> {
  const run = siteRun;
  siteRun = null;
  return run ? await run : [];
}

installSiteWorker({ sendBatch: sendFeedBatch });

/**
 * Ends the current collection: the host closes its session folder and
 * tells the desktop app; the next posts start a new session.
 */
async function completeCollection(complete: Omit<CollectionComplete, "type">): Promise<void> {
  const sites = await finishSiteRun();
  sendToDesktop({
    type: "collection-complete",
    ...complete,
    ...(sites.length > 0 ? { sites } : {}),
  });
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
    // The custom sites join here; completion waits for them.
    startSiteRun();
    // Batches that arrived while this waited in the queue went to this
    // session too: report the count as it stands now.
    await completeCollection({
      mode: "A",
      reason: "target-reached",
      uniquePostCount: await session.uniqueCount(),
      // The extension counter does not track responses outside a Mode B run.
      responseCount: 0,
      target: Math.min(settings.collectTarget, 10_000),
    });
    await chrome.action.setBadgeBackgroundColor({ color: TARGET_BADGE_COLOR });
  });
}

/**
 * Starts a new counting session. One host process == one capture
 * folder: retiring the port ends it once the host has answered, so the
 * next capture starts a fresh host session too.
 */
async function startNewCountingSession(): Promise<void> {
  generation += 1;
  desktopLinked = false;
  channel.retire();
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
  // Every run that started ends its session, whatever stopped it; the
  // desktop app decides from the reason whether to build the timeline.
  // A refused start (permission) never opened a session of its own.
  if (summary.stopReason !== "permission-missing") {
    await completeCollection({
      mode: "B",
      reason: summary.stopReason,
      uniquePostCount: summary.uniquePostCount,
      responseCount: summary.responseCount,
      target: Math.min(summary.target, 10_000),
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
  // Custom sites are collected alongside the run, into its session.
  startSiteRun();
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
  // Answered on this port, which stays open until its host relayed the
  // answer; starting the run opens a new host session.
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
    if (isWorkerRedditCaptureMessage(message) || isWorkerInstagramCaptureMessage(message)) {
      const { operation, bodyText } = message;
      const devSource = message.kind === "reddit-capture" ? "reddit" : "instagram";
      void loadSettings()
        .then((settings) => {
          if (settings.devCaptureEnabled) forwardDevCapture({ operation, bodyText }, devSource);
        })
        .catch((error: unknown) => {
          console.error(`[nmc] ${devSource} capture handling failed: ${String(error)}`);
        });
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

// --- Settings shared with the desktop app ----------------------------

// An Options save goes to settings.json through a one-shot host, which
// has no desktop link: the linked worker reports it, so the desktop
// shows it before its own next save (which would otherwise carry the
// older values with a newer stamp and undo it).
chrome.storage.onChanged.addListener((changes, areaName) => {
  const stamp = SettingsStampSchema.safeParse(changes[SETTINGS_STAMP_KEY]?.newValue);
  if (areaName !== "local" || !stamp.success || stamp.data.source !== "extension") return;
  if (!desktopLinked) return;
  void reportSettingsToDesktop().catch((error: unknown) => {
    console.error(`[nmc] settings report to the desktop failed: ${String(error)}`);
  });
});

/** Tells the desktop app the settings this extension holds, and when they were saved. */
async function reportSettingsToDesktop(): Promise<void> {
  const [settings, stamp] = await Promise.all([loadSettings(), loadSettingsStamp()]);
  sendToDesktop({
    type: "settings-sync",
    settings: ManagedSettingsSchema.parse(settings),
    stamp,
  });
}

/** Pushes are applied one at a time, each against the settings the last one left. */
let settingsWork: Promise<unknown> = Promise.resolve();

function applyPushedSettings(settings: unknown, stamp: SettingsStamp): void {
  settingsWork = settingsWork
    .then(async () => {
      const result = await applySettingsPush(
        { settings: ManagedSettingsSchema.parse(settings), stamp },
        {
          load: async () => ({
            settings: await loadSettings(),
            stamp: await loadSettingsStamp(),
          }),
          save: saveSettings,
          modeBPermitted: () =>
            chrome.permissions.contains({ permissions: MODE_B_PERMISSIONS }),
        },
      );
      sendToDesktop(result);
    })
    .catch((error: unknown) => {
      console.error(`[nmc] settings from the desktop app not applied: ${String(error)}`);
    });
}

/**
 * Once per browser start (and on install/update) the desktop gets the
 * current settings — not on every worker restart, each sync starts a
 * host process.
 */
async function syncSettingsAtStartup(): Promise<void> {
  const result = await syncSettings(
    await loadSettings(),
    sendNativeOnce,
    await loadSettingsStamp(),
  );
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

installDevCaptureScripts(chrome.scripting, chrome.storage);

// A restarted service worker picks up a run that was in progress.
listenToWatchdog();
void modeB.resume();
ensureDesktopLink();
