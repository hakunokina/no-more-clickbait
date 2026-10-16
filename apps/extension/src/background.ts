import {
  bridgeMessageByteLength,
  BridgeReplySchema,
  enabledCollectSources,
  ManagedSettingsSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseHomeTimeline,
  parseInstagramBody,
  parseInstagramTimeline,
  SettingsStampSchema,
  type BridgeMessage,
  type CaptureSource,
  type CaptureStats,
  type CollectionComplete,
  type CollectionStartResult,
  type CollectSource,
  type CollectSourceOutcome,
  type FeedBatch,
  type ModeBRunSummary,
  type PostBatch,
  type Settings,
  type SiteCollectOutcome,
  type SiteProgress,
  type SettingsStamp,
} from "@nmc/core";
import { CaptureSession, INSTAGRAM_SESSION_KEY } from "./capture-session.js";
import {
  COLLECTION_PROGRESS_KEY,
  readProgress,
  type CollectionProgressRecord,
} from "./collection-progress.js";
import { installDevCaptureScripts } from "./dev-capture-scripts.js";
import { setUiLang, t, watchUiLang } from "./i18n.js";
import {
  isCollectionFinishMessage,
  isModeBCommandMessage,
  isWorkerCaptureMessage,
  isWorkerInstagramCaptureMessage,
  isWorkerRedditCaptureMessage,
  type WorkerCaptureMessage,
  type WorkerInstagramCaptureMessage,
} from "./messages.js";
import {
  describeStopReason,
  errorText,
  isRateLimited,
  legsOf,
  legsText,
  MODE_B_LAST_RUN_KEY,
  MODE_B_PERMISSIONS,
  ModeBRunner,
  refusedRun,
  removeLegacyModeBPacing,
  runSource,
  runStopReason,
  sourceName,
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
import { DESKTOP_LANG_STORAGE_KEY } from "./settings-key.js";
import {
  applySettingsPush,
  NATIVE_HOST_NAME,
  sendNativeOnce,
  syncSettings,
} from "./settings-sync.js";
import {
  collectSitesForCollection,
  hasCollectableSites,
  installSiteWorker,
} from "./sites/site-worker.js";

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
 * With developer capture on, Instagram is captured the same way, as
 * `source: "instagram"`: the document's embedded first feed page and the
 * home feed's `/graphql/query` responses; the host parses them for its
 * folder's counts only.
 *
 * Instagram as a collection source (its own tick, next to X's): the same
 * bodies are parsed here into Instagram posts and join the collection's
 * host session as `feed-batch` (outside X's counts), counted by their own
 * session counter (never the host's). Every scrolled feed has its own
 * count against the same "Posts to collect": in Mode A the collection
 * completes once every feed reached it (a feed that did is closed: its
 * later posts stay out), or when the user finishes it from the popup;
 * Mode B scrolls the feeds one after the other in its window. The badge
 * shows the count of the feed counted last, its tooltip every feed's.
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
 * extension saved later (settings-sync.ts applySettingsPush). The
 * desktop also says which language it shows (`ui-lang`, on linking up
 * and on every change); "system" here means that language.
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
/** X's counter (the first one, kept under its key); Instagram has its own. */
const session = new CaptureSession(chrome.storage.session);
const igSession = new CaptureSession(chrome.storage.session, INSTAGRAM_SESSION_KEY);

function sessionOf(source: CollectSource): CaptureSession {
  return source === "x" ? session : igSession;
}

/**
 * session: a feed (X, Instagram) sent posts to the current host session —
 * kept apart from the counters, which a tick turned off resets.
 */
const FEED_POSTS_SENT_KEY = "nmc.feedPostsSent";
let postsSent = false;

async function markFeedPostsSent(): Promise<void> {
  if (postsSent) return;
  postsSent = true;
  await chrome.storage.session.set({ [FEED_POSTS_SENT_KEY]: true }).catch(() => undefined);
}

async function feedPostsSent(): Promise<boolean> {
  if (postsSent) return true;
  const items = await chrome.storage.session.get(FEED_POSTS_SENT_KEY).catch(() => ({}));
  return (items as Record<string, unknown>)[FEED_POSTS_SENT_KEY] === true;
}

let linkRetryMs = LINK_RETRY_FIRST_MS;
let linkTimer: ReturnType<typeof setTimeout> | null = null;
/** The current session's host is linked to the desktop app. */
let desktopLinked = false;

const channel = new NativeChannel(openNativePort);
/** Notification texts wait for the desktop's language (a restarted worker reads it again). */
const uiLangReady = watchUiLang(setUiLang);

/** The counting session (generation) whose host process this worker already started. */
let hostGeneration: number | null = null;

function openNativePort(): chrome.runtime.Port {
  const opened = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  const portGeneration = generation;
  // Each host process counts X from zero. A port opened mid-session — the
  // worker restarted (generation 0 goes on with the stored session) or the
  // host went away — continues from the count shown so far.
  const countBase =
    portGeneration === 0 || hostGeneration === portGeneration
      ? loadProgress().then(() => progress.x?.count ?? 0)
      : Promise.resolve(0);
  hostGeneration = portGeneration;
  let answered = false;
  opened.onDisconnect.addListener(() => {
    // Gone without a word: not installed, or it would not start. A host
    // that answered and then went away is only reconnected (below).
    if (!answered) hostUnreachable(chrome.runtime.lastError?.message);
    // Host gone (crashed, not installed): reopen the link, backing off.
    if (channel.lost(opened)) scheduleDesktopLink();
  });
  opened.onMessage.addListener((reply: unknown) => {
    answered = true;
    channel.received(opened, reply);
    void handleReply(reply, portGeneration, countBase).catch((error: unknown) => {
      console.error(`[nmc] native host reply handling failed: ${String(error)}`);
    });
  });
  return opened;
}

/**
 * A Mode B run has nowhere to send what it collects (nor, with developer
 * capture on, anyone to count it): it ends with that reason instead of
 * scrolling on until it looks stalled.
 */
function hostUnreachable(detail: string | undefined): void {
  runCommand(async () => {
    if (!(await modeB.current())) return;
    console.error(`[nmc] native host unreachable: ${detail ?? "it closed without answering"}`);
    await modeB.stop("host-unreachable", detail ?? null);
  });
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

/** The desktop app shows a Mode B run's count as it goes (its feed's, when not X). */
function reportProgress(run: ModeBRun | null, count: number): void {
  if (!run) return;
  sendProgress(runSource(run), count, run.target);
}

/**
 * What a collection the desktop app shows (a Mode B run, or the custom
 * sites alone) last reported, and its custom sites' progress: a site's
 * change goes out as the same `collection-progress` with the new list,
 * and the feed's counts carry the list too. Cleared with the counting
 * session (Mode A reports none).
 */
let progressSent: { source: CollectSource; count: number; target: number } | null = null;
let sitesProgress: SiteProgress[] | null = null;

function sendProgress(source: CollectSource, count: number, target: number): void {
  progressSent = { source, count, target };
  sendToDesktop({
    type: "collection-progress",
    mode: "B",
    uniquePostCount: count,
    target: Math.min(target, 10_000),
    ...(source === "x" ? {} : { source }),
    ...(sitesProgress ? { sites: sitesProgress } : {}),
  });
}

function sendSitesProgress(sites: SiteProgress[]): void {
  sitesProgress = sites;
  if (progressSent) sendProgress(progressSent.source, progressSent.count, progressSent.target);
}

async function updateBadge(count: number): Promise<void> {
  await chrome.action.setBadgeText({ text: count === 0 ? "" : String(count) });
}

// --- Per-feed progress (popup, badge tooltip) -------------------------

let progress: CollectionProgressRecord = {};
/** Read once: a restarted worker carries on with the stored counts. */
let progressLoaded: Promise<void> | null = null;
let progressWrites: Promise<unknown> = Promise.resolve();
/** The tooltip shows per-feed counts (reset with the counting session). */
let titled = false;

function loadProgress(): Promise<void> {
  progressLoaded ??= chrome.storage.session
    .get(COLLECTION_PROGRESS_KEY)
    .then((items) => {
      progress = { ...readProgress(items[COLLECTION_PROGRESS_KEY]), ...progress };
    })
    .catch(() => undefined);
  return progressLoaded;
}

/** Applies `change` to the record and stores it (writes in order). */
async function changeProgress(
  change: (record: CollectionProgressRecord) => CollectionProgressRecord,
): Promise<void> {
  await loadProgress();
  progress = change(progress);
  const snapshot = progress;
  // An empty record (a new session) leaves nothing behind.
  progressWrites = progressWrites
    .then(() =>
      Object.keys(snapshot).length === 0
        ? chrome.storage.session.remove(COLLECTION_PROGRESS_KEY)
        : chrome.storage.session.set({ [COLLECTION_PROGRESS_KEY]: snapshot }),
    )
    .catch(() => undefined);
  await progressWrites;
}

/** A feed's new count: the badge shows it, the tooltip every feed's (several feeds only). */
async function showCount(
  source: CollectSource,
  count: number,
  settings: Settings | null,
): Promise<void> {
  await changeProgress((record) => ({ ...record, [source]: { ...record[source], count } }));
  await updateBadge(count);
  if (settings && enabledCollectSources(settings).some((feed) => feed !== "x")) {
    titled = true;
    await chrome.action.setTitle({ title: progressTitle(settings) });
  }
}

function progressTitle(settings: Settings): string {
  const parts = enabledCollectSources(settings).map((source) =>
    t(
      progress[source]?.closed ? "progressSourceDone" : "progressSource",
      sourceName(source),
      progress[source]?.count ?? 0,
      settings.collectTarget,
    ),
  );
  return t("badgeTitleSources", parts.join(" · "));
}

/** Closes a feed's part of the collection: its later posts stay out. */
async function closeSource(source: CollectSource, reason: string): Promise<void> {
  await sessionOf(source).close(reason);
  await changeProgress((record) => ({
    ...record,
    [source]: { count: record[source]?.count ?? 0, ...record[source], closed: reason },
  }));
}

/**
 * A feed's count as it stands now, after every count already queued:
 * X's is the host's while developer capture is on (it alone counts then).
 */
async function countOf(source: CollectSource, settings: Settings): Promise<number> {
  if (source === "x" && settings.devCaptureEnabled) {
    await loadProgress();
    return progress.x?.count ?? 0;
  }
  return sessionOf(source).uniqueCount();
}

async function handleReply(
  raw: unknown,
  replyGeneration: number,
  countBase: Promise<number>,
): Promise<void> {
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
  if (reply.type === "ui-lang") {
    // Pages (and this worker) set to "system" follow it via watchUiLang.
    await chrome.storage.local.set({ [DESKTOP_LANG_STORAGE_KEY]: reply.lang });
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
    await reflectCaptureStats(reply.stats, replyGeneration, countBase);
  } else if (reply.type === "error") {
    console.error(`[nmc] native host error: ${reply.message}`);
  }
}

async function reflectCaptureStats(
  stats: CaptureStats,
  replyGeneration: number,
  countBase: Promise<number>,
): Promise<void> {
  const settings = await loadSettings().catch(() => null);
  if (!settings?.devCaptureEnabled || replyGeneration !== generation) return;
  // X is not collected, or its part of this collection ended: its count stands.
  if (!settings.collectFromX || (await session.closedReason()) !== null) return;
  // A post seen by both host processes counts twice: an approximation the
  // dumps (split over their two folders) share.
  const count = (await countBase) + stats.uniquePostCount;
  await showCount("x", count, settings);
  const run = await modeB.current();
  if (run?.counter === "host" && runSource(run) === "x") {
    reportProgress(run, count);
  }
  await modeB.onCount(count, "host");
  const reached = await session.reachedTarget(count, settings.collectTarget);
  if (!reached || replyGeneration !== generation) return;
  await chrome.action.setBadgeBackgroundColor({ color: TARGET_BADGE_COLOR });
  await uiLangReady;
  try {
    await chrome.notifications.create(CAPTURE_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: t("notifyCaptureTitle"),
      message: t("notifyCaptureBody", count, stats.responseCount, settings.collectTarget),
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
  // X's tick is off: its responses are only captured (above), never collected.
  if (settings && !settings.collectFromX) return;

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
  // X's part of this collection ended while another feed still collects.
  if ((await session.closedReason()) !== null) return;
  // Stored before counting: the count may complete the collection, and
  // the batch that reached the target belongs to it.
  const batch: PostBatch = {
    source: "x-home-timeline",
    capturedAt: new Date().toISOString(),
    posts,
  };
  if (sendToDesktop({ type: "post-batch", batch })) await markFeedPostsSent();

  // With capture ON the host's count is the single source (see top).
  if (!settings?.devCaptureEnabled) {
    const uniqueCount = await session.countPosts(posts);
    if (captureGeneration === generation) {
      await showCount("x", uniqueCount, settings);
      const run = await modeB.current();
      if (run?.counter === "extension" && runSource(run) === "x") {
        reportProgress(run, uniqueCount);
      }
      await modeB.onCount(uniqueCount, "extension");
      // Developer capture keeps its own semantics (one folder, capture
      // continues past the target), so Mode A completes only without it.
      if (!run && settings) completeModeA("x", uniqueCount, settings, captureGeneration);
    }
  }
}

/**
 * Instagram as a collection source: the page's own feed bodies (the
 * document's first page, then `/graphql/query` pages) become Instagram
 * posts on the collection's host session, counted apart from X. Ads stay
 * in the batch, as X's do: the pipeline's hard filter drops them, and so
 * does this count; suggested posts are kept (marked `suggested`).
 */
async function handleInstagramCapture(
  message: WorkerInstagramCaptureMessage,
  tabId: number | undefined,
): Promise<void> {
  const captureGeneration = generation;
  const settings: Settings | null = await loadSettings().catch(() => null);
  if (settings?.devCaptureEnabled) {
    forwardDevCapture(
      { operation: message.operation, bodyText: message.bodyText },
      "instagram",
    );
  }
  if (!settings?.collectFromInstagram) return;
  await modeB.onResponse(tabId, false, "instagram");
  const posts = parseInstagramTimeline(parseInstagramBody(message.bodyText));
  if (posts.length === 0 || (await igSession.closedReason()) !== null) return;
  if (sendFeedBatch({ capturedAt: new Date().toISOString(), items: posts })) {
    await markFeedPostsSent();
  }
  // "Only accounts I follow": suggestions still ride along (the pipeline's
  // hard filter drops them, counted apart) but never count towards the target.
  const counted = settings.instagramFollowedOnly
    ? posts.filter((post) => post.suggested !== true)
    : posts;
  const count = await igSession.countPosts(counted);
  if (captureGeneration !== generation) return;
  await showCount("instagram", count, settings);
  const run = await modeB.current();
  if (run && runSource(run) === "instagram") reportProgress(run, count);
  await modeB.onCount(count, "extension", "instagram");
  // As X's: with developer capture on, Mode A never completes on its own.
  if (!run && !settings.devCaptureEnabled) {
    completeModeA("instagram", count, settings, captureGeneration);
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
/**
 * session: the outcomes of the collection's finished site run. A Mode B
 * run outlives the service worker (watchdog), and the in-memory run with
 * it; completion then reports what was kept here.
 */
const SITE_RUN_OUTCOMES_KEY = "nmc.siteRunOutcomes";

/**
 * `shown`: the desktop app shows this collection (Mode B, or the sites
 * alone) — the sites' progress goes out with the count of `source`.
 */
function startSiteRun(shown?: { source: CollectSource; target: number }): void {
  if (siteRun) return;
  if (shown) progressSent = { ...shown, count: 0 };
  siteRun = chrome.storage.session
    .remove(SITE_RUN_OUTCOMES_KEY)
    .catch(() => undefined)
    .then(() => collectSitesForCollection(sendFeedBatch, shown ? sendSitesProgress : undefined))
    .then(async (outcomes) => {
      await chrome.storage.session
        .set({ [SITE_RUN_OUTCOMES_KEY]: outcomes })
        .catch(() => undefined);
      return outcomes;
    });
}

async function finishSiteRun(): Promise<SiteCollectOutcome[]> {
  const run = siteRun;
  siteRun = null;
  const stored = await chrome.storage.session
    .get(SITE_RUN_OUTCOMES_KEY)
    .then((items) => items[SITE_RUN_OUTCOMES_KEY] as SiteCollectOutcome[] | undefined)
    .catch(() => undefined);
  const outcomes = run ? await run : (stored ?? []);
  await chrome.storage.session.remove(SITE_RUN_OUTCOMES_KEY).catch(() => undefined);
  return outcomes;
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
  await updateBadge(complete.sources?.at(-1)?.uniquePostCount ?? complete.uniquePostCount);
}

/** True for a collection of X alone (its outcomes need no per-feed list). */
function xOnly(sources: readonly CollectSource[]): boolean {
  return sources.length === 1 && sources[0] === "x";
}

/** Each feed's outcome, for a collection that was not X alone. */
function sourceOutcomes(
  sources: readonly CollectSource[],
  outcome: (source: CollectSource) => { count: number; reason: string },
  target: number,
): { sources?: CollectSourceOutcome[] } {
  if (xOnly(sources)) return {};
  return {
    sources: sources.map((source) => {
      const { count, reason } = outcome(source);
      return { source, uniquePostCount: count, reason, target: Math.min(target, 10_000) };
    }),
  };
}

/**
 * Mode A: a feed's count (the user's own scrolling) reached the target.
 * The collection completes once every collected feed did; until then
 * that feed is closed and the others go on.
 */
function completeModeA(
  source: CollectSource,
  count: number,
  settings: Settings,
  countGeneration: number,
): void {
  if (count < settings.collectTarget || countGeneration !== generation) return;
  runCommand(() => settleModeA(countGeneration, source));
}

/**
 * Completes a Mode A collection when every feed collected now is at the
 * target: closed there, or `reached` (the feed whose count just got
 * there). Otherwise `reached` is closed and the others go on. With no
 * feed on any more, it ends without them. Runs in the command queue.
 */
async function settleModeA(countGeneration: number, reached?: CollectSource): Promise<void> {
  // Another message may have completed this session already.
  if (countGeneration !== generation || (await modeB.current())) return;
  // Read now, not when the count was taken: a tick turned off meanwhile
  // keeps its feed out of the completion.
  const settings = await loadSettings();
  // As a count's: with developer capture on, Mode A never completes on its own.
  if (settings.devCaptureEnabled) return;
  const sources = enabledCollectSources(settings);
  if (sources.length === 0) {
    // With no post sent, nothing is open: the turned-off feeds' counters were reset.
    if (await feedPostsSent()) await completeWithoutFeeds(settings);
    return;
  }
  if (reached && !sources.includes(reached)) reached = undefined;
  for (const other of sources) {
    if (other === reached || (await sessionOf(other).closedReason()) !== null) continue;
    if ((await countOf(other, settings)) < settings.collectTarget) {
      if (reached) await closeSource(reached, "target-reached");
      return;
    }
  }
  // The custom sites join here; completion waits for them.
  startSiteRun();
  // Batches that arrived while this waited in the queue went to this
  // session too: report the counts as they stand now.
  const counts = new Map<CollectSource, number>();
  for (const feed of sources) counts.set(feed, await countOf(feed, settings));
  await completeCollection({
    mode: "A",
    reason: "target-reached",
    uniquePostCount: counts.get("x") ?? 0,
    // The extension counter does not track responses outside a Mode B run.
    responseCount: 0,
    target: Math.min(settings.collectTarget, 10_000),
    ...sourceOutcomes(
      sources,
      (feed) => ({ count: counts.get(feed) ?? 0, reason: "target-reached" }),
      settings.collectTarget,
    ),
  });
  await chrome.action.setBadgeBackgroundColor({ color: TARGET_BADGE_COLOR });
}

/**
 * Mode A, a feed's tick changed mid-collection: what was collected is
 * kept. The toggled feed starts over — turned on, it counts from now;
 * turned off, it is out of this collection (the completion names only
 * the feeds still on, and the desktop leaves out what the others
 * stored) — and the collection completes if every feed still on is
 * already at the target.
 *
 * Off and on again: the count restarts, yet the posts the feed sent
 * before it was turned off stay in the host session, and the completion
 * names the feed, so they are judged too. Deliberate — nothing the user
 * scrolled is lost; only the count shown runs lower than what goes in.
 */
async function sourcesToggled(toggled: readonly CollectSource[]): Promise<void> {
  for (const source of toggled) await sessionOf(source).reset();
  await changeProgress((record) => {
    const next = { ...record };
    for (const source of toggled) delete next[source];
    return next;
  });
  await settleModeA(generation);
}

/**
 * The popup's "Finish now": ends the user's own collection (Mode A)
 * short of its targets; the desktop app asks before building it. Nothing
 * happens during a Mode B run (it has its own Stop) or before any post.
 */
async function finishCollectionNow(): Promise<void> {
  if (await modeB.current()) return;
  const settings = await loadSettings();
  const sources = enabledCollectSources(settings);
  if (sources.length === 0) {
    if (await feedPostsSent()) await completeWithoutFeeds(settings);
    return;
  }
  const counts = new Map<CollectSource, number>();
  const closed = new Map<CollectSource, string | null>();
  for (const source of sources) {
    counts.set(source, await countOf(source, settings));
    closed.set(source, await sessionOf(source).closedReason());
  }
  if (![...counts.values()].some((count) => count > 0)) return;
  startSiteRun();
  await completeCollection({
    mode: "A",
    reason: "finished-early",
    uniquePostCount: counts.get("x") ?? 0,
    responseCount: 0,
    target: Math.min(settings.collectTarget, 10_000),
    ...sourceOutcomes(
      sources,
      (source) => ({
        count: counts.get(source) ?? 0,
        reason: closed.get(source) ?? "finished-early",
      }),
      settings.collectTarget,
    ),
  });
}

/**
 * Mode A, X and Instagram were both turned off after posts went to the
 * host: the collection ends with no feed named (the desktop leaves their
 * posts out), the custom sites' items alone, and waits for the user's
 * go as any collection finished early.
 */
async function completeWithoutFeeds(settings: Settings): Promise<void> {
  startSiteRun();
  await completeCollection({
    mode: "A",
    reason: "finished-early",
    uniquePostCount: 0,
    responseCount: 0,
    target: Math.min(settings.collectTarget, 10_000),
    sources: [],
  });
}

/**
 * X and Instagram are both off: a collection is the custom sites alone,
 * collected at once (no window, Mode B or not) into a session of its own.
 */
async function collectSitesOnly(target: number): Promise<void> {
  await startNewCountingSession();
  startSiteRun({ source: "x", target });
  await completeCollection({
    mode: "B",
    reason: "sites-collected",
    uniquePostCount: 0,
    responseCount: 0,
    target: Math.min(target, 10_000),
    sources: [],
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
  // Cleared with the port it belongs to, before any await: a batch sent
  // on the next port meanwhile marks the new session, not this one.
  postsSent = false;
  progressSent = null;
  sitesProgress = null;
  const sentCleared = chrome.storage.session.remove(FEED_POSTS_SENT_KEY).catch(() => undefined);
  await session.reset();
  await igSession.reset();
  await sentCleared;
  await changeProgress(() => ({}));
  if (titled) {
    titled = false;
    await uiLangReady;
    await chrome.action.setTitle({ title: t("extName") });
  }
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
  closeWindow: (windowId) => chrome.windows.remove(windowId),
  sendStep: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  async navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },
};

const modeB = new ModeBRunner(modeBBrowser, chrome.storage.session, {
  onFinish: finishModeB,
  onLegFinish: finishModeBLeg,
});

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

/**
 * One feed's leg of a Mode B run ended and `next` takes the window over:
 * the feed's part of the collection is closed (its later posts stay
 * out), and the desktop app hears the next feed start from zero.
 * Runs inside the runner's queue: it must not call the runner.
 */
async function finishModeBLeg(leg: ModeBRunSummary, next: CollectSource): Promise<void> {
  const source = leg.source ?? "x";
  await closeSource(source, leg.stopReason);
  // Recorded next to the run's X dumps (developer capture).
  if (source === "x" && leg.counter === "host") sendToDesktop({ type: "mode-b-run", run: leg });
  sendProgress(next, 0, leg.target);
}

async function finishModeB(summary: ModeBRunSummary): Promise<void> {
  const legs = legsOf(summary);
  const reason = runStopReason(summary);
  await chrome.storage.local.set({ [MODE_B_LAST_RUN_KEY]: summary });
  await alarms()?.clear(MODE_B_WATCHDOG_ALARM);
  // Recorded next to the run's dumps; a run that never started has none.
  // (An X leg followed by another feed was recorded when it ended.)
  if (
    (summary.source ?? "x") === "x" &&
    summary.counter === "host" &&
    summary.stopReason !== "permission-missing"
  ) {
    sendToDesktop({ type: "mode-b-run", run: summary });
  }
  // Every run that started ends its session, whatever stopped it; the
  // desktop app decides from the reason whether to build the timeline.
  // A refused start (permission) never opened a session of its own. The
  // top-level counts stay X's; every feed's are in `sources`.
  if (summary.stopReason !== "permission-missing") {
    const x = legs.find((leg) => leg.source === "x");
    await completeCollection({
      mode: "B",
      reason,
      uniquePostCount: x?.uniquePostCount ?? 0,
      responseCount: x?.responseCount ?? 0,
      target: Math.min(summary.target, 10_000),
      ...sourceOutcomes(
        legs.map((leg) => leg.source),
        (source) => {
          const leg = legs.find((candidate) => candidate.source === source);
          return { count: leg?.uniquePostCount ?? 0, reason: leg?.stopReason ?? reason };
        },
        summary.target,
      ),
    });
  }
  const reached = reason === "target-reached";
  await chrome.action.setBadgeBackgroundColor({
    color: reached ? TARGET_BADGE_COLOR : DEFAULT_BADGE_COLOR,
  });
  await uiLangReady;
  try {
    await chrome.notifications.create(MODE_B_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: t(reached ? "notifyModeBFinished" : "notifyModeBStopped"),
      message:
        summary.legs === undefined
          ? t(
              "notifyModeBBody",
              summary.uniquePostCount,
              summary.target,
              Math.round(summary.durationMs / 1000),
              summary.scrollCount,
              describeStopReason(summary.stopReason, summary.source),
            )
          : t("notifyModeBLegsBody", legsText(summary.legs)),
    });
  } catch {
    // Notification is best-effort; the options page shows the last run.
  }
}

/** "no-sources": X, Instagram and every custom site are off — nothing was started. */
type StartOutcome = "no-sources" | undefined;

async function startModeB(target?: number): Promise<StartOutcome> {
  const settings = await loadSettings();
  if (!settings.modeBEnabled || (await modeB.current())) return;
  const sources = enabledCollectSources(settings);
  if (sources.length === 0) {
    if (!(await hasCollectableSites())) return "no-sources";
    await collectSitesOnly(target ?? settings.collectTarget);
    return;
  }
  const start: ModeBStart = {
    strategy: settings.modeBStrategy,
    target: target ?? settings.collectTarget,
    counter: settings.devCaptureEnabled ? "host" : "extension",
    ...(xOnly(sources) ? {} : { sources }),
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
  startSiteRun({ source: sources[0] ?? "x", target: start.target });
  await modeB.start(start).catch(async (error: unknown) => {
    // Thrown before a run existed: nothing else will complete this
    // collection. It ends as a run that failed to open, which closes the
    // session it opened and waits out (holding the command queue) and
    // drops its site run, so the next collection neither overlaps nor
    // reports it. The start's own error is the one rethrown.
    try {
      await finishModeB(refusedRun(start, Date.now(), "failed-to-open", errorText(error)));
    } catch (finishError) {
      console.error(`[nmc] Mode B could not end its failed start: ${String(finishError)}`);
    }
    throw error;
  });
}

/** The desktop app asked for a new timeline ("Collect new timeline"). */
async function startCollectionForDesktop(target: number | undefined): Promise<void> {
  const settings = await loadSettings();
  const goal = target ?? settings.collectTarget;
  const sources = enabledCollectSources(settings);
  const answer = (outcome: CollectionStartResult["outcome"]): void => {
    sendToDesktop({
      type: "collection-start-result",
      outcome,
      target: goal,
      ...(xOnly(sources) ? {} : { sources }),
    });
  };
  if (sources.length === 0) {
    if (await modeB.current()) return answer("busy");
    if (!(await hasCollectableSites())) return answer("no-sources");
    // Only custom sites: collected at once, whether Mode B is on or not.
    answer("started");
    await collectSitesOnly(goal);
    return;
  }
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
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse?: (response?: unknown) => void,
  ) => {
    if (isModeBCommandMessage(message)) {
      // Only the extension's own pages (not content scripts) may start or stop a run.
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      if (message.command === "stop") {
        runCommand(() => modeB.stop("cancelled"));
        return;
      }
      // The page learns when nothing could be collected at all.
      runCommand(async () => {
        let outcome: StartOutcome;
        try {
          outcome = await startModeB();
        } finally {
          sendResponse?.(outcome);
        }
      });
      return true;
    }
    if (isCollectionFinishMessage(message)) {
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      runCommand(finishCollectionNow);
      return;
    }
    if (isWorkerInstagramCaptureMessage(message)) {
      const capture: WorkerInstagramCaptureMessage = {
        kind: message.kind,
        operation: message.operation,
        bodyText: message.bodyText,
      };
      void handleInstagramCapture(capture, sender.tab?.id).catch((error: unknown) => {
        console.error(`[nmc] instagram capture handling failed: ${String(error)}`);
      });
      return;
    }
    if (isWorkerRedditCaptureMessage(message)) {
      const { operation, bodyText } = message;
      void loadSettings()
        .then((settings) => {
          if (settings.devCaptureEnabled) forwardDevCapture({ operation, bodyText }, "reddit");
        })
        .catch((error: unknown) => {
          console.error(`[nmc] reddit capture handling failed: ${String(error)}`);
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

const SOURCE_TICKS = {
  x: "collectFromX",
  instagram: "collectFromInstagram",
} as const satisfies Record<CollectSource, string>;

function flag(
  value: unknown,
  key: "devCaptureEnabled" | "modeBEnabled" | "collectFromX" | "collectFromInstagram",
): boolean {
  const stored = (value as Record<string, unknown> | undefined)?.[key];
  // X's tick defaults to on: settings saved before it existed collect X.
  return key === "collectFromX" ? stored !== false : Boolean(stored);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[SETTINGS_STORAGE_KEY];
  if (areaName !== "local" || !change) return;
  const captureToggled =
    flag(change.oldValue, "devCaptureEnabled") !== flag(change.newValue, "devCaptureEnabled");
  const modeBTurnedOff =
    flag(change.oldValue, "modeBEnabled") && !flag(change.newValue, "modeBEnabled");
  // A run scrolls the feeds that were on when it started.
  const toggled = (Object.keys(SOURCE_TICKS) as CollectSource[]).filter(
    (source) =>
      flag(change.oldValue, SOURCE_TICKS[source]) !==
      flag(change.newValue, SOURCE_TICKS[source]),
  );
  if (!captureToggled && !modeBTurnedOff && toggled.length === 0) return;
  runCommand(async () => {
    const running = (await modeB.current()) !== null;
    // A run's counts belong to the session it ran in: end it first.
    await modeB.stop("settings-changed");
    if (captureToggled) await startNewCountingSession();
    else if (toggled.length > 0 && !running) await sourcesToggled(toggled);
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

chrome.runtime.onInstalled.addListener(() => {
  void removeLegacyModeBPacing();
});

installDevCaptureScripts(chrome.scripting, chrome.storage);

// A restarted service worker picks up a run that was in progress.
listenToWatchdog();
void modeB.resume();
ensureDesktopLink();
