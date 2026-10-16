import {
  formatMessage,
  INTL_LOCALES,
  plural,
  type CollectSource,
  type CollectSourceOutcome,
  type MessageRef,
  type MessageTable,
  type SiteProgress,
  type UiLang,
} from "@nmc/core";
import type { FeedProgress, RunStage } from "./status.js";

/**
 * Every word the desktop app shows — monitor, reading window, Settings,
 * tray, notifications and the status notes main sends — in English and
 * Turkish. `tr` is typed against `en` (same keys, same arguments).
 *
 * Main never puts a sentence into the status: it sends a `Note` (a key
 * and its plain-data arguments), and each window puts it into words in
 * the language it shows, so a language change re-words everything at
 * once. Arguments are counts, raw stop reasons and browser families;
 * the table formats them for its own language.
 */

const enCount = (n: number): string => n.toLocaleString(INTL_LOCALES.en);
const trCount = (n: number): string => n.toLocaleString(INTL_LOCALES.tr);
const enPosts = (n: number): string =>
  `${enCount(n)} ${plural("en", n, { one: "post", other: "posts" })}`;

const BROWSER_NAMES: Readonly<Record<string, string>> = {
  brave: "Brave",
  chrome: "Chrome",
  edge: "Microsoft Edge",
  vivaldi: "Vivaldi",
  opera: "Opera",
};
const enBrowser = (family: string): string => BROWSER_NAMES[family] ?? "your browser";
const trBrowser = (family: string): string => BROWSER_NAMES[family] ?? "tarayıcın";

const EN_STOP_REASONS: Readonly<Record<string, string>> = {
  "target-reached": "target reached",
  timeout: "time limit reached",
  stalled: "no new posts for about 20 s of scrolling",
  "not-logged-in": "not logged in to X in this browser",
  "error-page": "X showed an error page",
  "navigated-away": "the tab left x.com/home",
  "rate-limited": "X rate-limited the timeline",
  "page-unresponsive": "the page stopped answering scroll steps",
  "tab-closed": "the collection tab was closed",
  cancelled: "stopped by you",
  "settings-changed": "the extension's settings changed during the run",
  "failed-to-open": "the collection tab or window could not be opened",
  "finished-early": "finished by you",
  "sites-collected": "custom sites collected",
};

/** Where a reason names the site, Instagram's own words. */
const EN_INSTAGRAM_STOP_REASONS: Readonly<Record<string, string>> = {
  "not-logged-in": "not logged in to Instagram in this browser",
  "error-page": "Instagram showed an error page",
  "navigated-away": "the tab left instagram.com",
  "rate-limited": "Instagram rate-limited the feed",
};

const TR_STOP_REASONS: Readonly<Record<string, string>> = {
  "target-reached": "hedefe ulaşıldı",
  timeout: "süre sınırı doldu",
  stalled: "yaklaşık 20 sn kaydırmada yeni gönderi gelmedi",
  "not-logged-in": "bu tarayıcıda X oturumu açık değil",
  "error-page": "X bir hata sayfası gösterdi",
  "navigated-away": "sekme x.com/home'dan ayrıldı",
  "rate-limited": "X akışı hız sınırına takıldı",
  "page-unresponsive": "sayfa kaydırma adımlarına yanıt vermez oldu",
  "tab-closed": "toplama sekmesi kapatıldı",
  cancelled: "sen durdurdun",
  "settings-changed": "çalışma sırasında eklentinin ayarları değişti",
  "failed-to-open": "toplama sekmesi ya da penceresi açılamadı",
  "finished-early": "sen bitirdin",
  "sites-collected": "özel siteler toplandı",
};

const TR_INSTAGRAM_STOP_REASONS: Readonly<Record<string, string>> = {
  "not-logged-in": "bu tarayıcıda Instagram oturumu açık değil",
  "error-page": "Instagram bir hata sayfası gösterdi",
  "navigated-away": "sekme instagram.com'dan ayrıldı",
  "rate-limited": "Instagram akışı hız sınırına takıldı",
};

/** The scrolled feeds by name (the same in both languages). */
const FEED_NAMES: Readonly<Record<CollectSource, string>> = { x: "X", instagram: "Instagram" };
/** Turkish locative suffix after each feed's name ("X'te", "Instagram'da"). */
const TR_LOCATIVE: Readonly<Record<CollectSource, string>> = { x: "'te", instagram: "'da" };
/** Where the user browses each feed in Mode A. */
const FEED_PLACES: Readonly<Record<CollectSource, string>> = {
  x: "x.com/home",
  instagram: "instagram.com",
};

const EN_STAGES: Readonly<Record<RunStage, string>> = {
  idle: "idle",
  checking: "checking the claude CLI",
  filtering: "filtering",
  scoring: "scoring",
  verifying: "verifying",
  rendering: "writing the timeline",
  ready: "timeline ready",
  error: "failed",
  cancelled: "cancelled",
};

const TR_STAGES: Readonly<Record<RunStage, string>> = {
  idle: "boşta",
  checking: "claude CLI denetleniyor",
  filtering: "ayıklanıyor",
  scoring: "puanlanıyor",
  verifying: "doğrulanıyor",
  rendering: "akış yazılıyor",
  ready: "akış hazır",
  error: "başarısız",
  cancelled: "iptal edildi",
};

/** A custom site's state, as the monitor's site list words it. */
const EN_SITE_STATUS: Readonly<Record<SiteProgress["status"], string>> = {
  waiting: "Waiting",
  collecting: "Collecting",
  ok: "Done",
  empty: "No items",
  error: "Could not be read",
  timeout: "Timed out",
  skipped: "Skipped",
};

const TR_SITE_STATUS: Readonly<Record<SiteProgress["status"], string>> = {
  waiting: "Sırada",
  collecting: "Toplanıyor",
  ok: "Bitti",
  empty: "Öğe yok",
  error: "Okunamadı",
  timeout: "Zaman aşımı",
  skipped: "Atlandı",
};

const en = {
  appTagline: "Your feed, filtered. Finite by design.",
  // Monitor
  linkWaiting: "Waiting for the browser extension…",
  technicalDetail: "Technical detail",
  openReader: "Open reading window",
  openSettings: "Settings…",
  tokenMonitor: "Token monitor",
  statCollected: "Collected",
  statFilteredOut: "Filtered out",
  statVerified: "Verified claims",
  statKept: "Posts kept / seen",
  statInputTokens: "Input tokens",
  statCacheTokens: "Cache tokens",
  statOutputTokens: "Output tokens",
  statThinkingTokens: "Thinking tokens",
  statCost: "Estimated cost",
  statRunTime: "Run time",
  statStageTimes: "Stage times",
  statCollectionSpan: "Collection span",
  statLastRun: "Last run",
  never: "Never",
  running: "Running…",
  stageScore: (time: string) => `score ${time}`,
  stageVerify: (time: string) => `verify ${time}`,
  /** The run's steps, as the monitor lists them under the ring. */
  stepFilter: "Filtering",
  stepScore: "Scoring",
  stepVerify: "Verifying",
  stepWrite: "Writing",
  /** The word under the ring's number. */
  unitPosts: (n: number) => plural("en", n, { one: "post", other: "posts" }),
  unitClaims: (n: number) => plural("en", n, { one: "claim", other: "claims" }),
  /** The custom sites of a collection, one line each under the feeds. */
  sitesTitle: (done: number, total: number) => `Custom sites · ${done}/${total} done`,
  sitesProblems: (n: number) =>
    `${enCount(n)} ${plural("en", n, { one: "problem", other: "problems" })}`,
  siteStatus: (status: SiteProgress["status"]) => EN_SITE_STATUS[status],
  siteItems: (n: number) => `${enCount(n)} ${plural("en", n, { one: "item", other: "items" })}`,
  llmNotChecked: "Not checked yet.",
  llmCheck: "Check the claude CLI",
  llmChecking: "Checking…",
  llmReady: (version: string) => `Ready — claude CLI ${version}`,
  llmNotFound: "claude CLI not found on PATH. Install it and log in, then check again.",
  llmNotAuthenticated: "claude CLI is installed but not logged in. Log in with the CLI first.",
  llmFailed: (detail: string) => `CLI check failed: ${detail}`,
  failed: (error: string) => `Failed: ${error}`,
  pendingModeA: (posts: number) =>
    `${enPosts(posts)} collected while you browsed. Build the timeline? (Uses your claude CLI.)`,
  pendingModeB: (reason: string, posts: number) =>
    `The collection stopped early (${enStop(reason)}) with ${enPosts(posts)}. Build the timeline anyway? (Uses your claude CLI.)`,
  seconds: (s: number) => `${s} s`,
  minutes: (m: number) => `${m} min`,
  minutesSeconds: (m: number, s: number) => `${m} min ${s} s`,
  // Run line
  runChecking: "Checking the claude CLI…",
  runFiltering: "Filtering ads and repeats…",
  runScoring: (posts: number | null) =>
    posts === null ? "Scoring posts…" : `Scoring ${enPosts(posts)}…`,
  runVerifying: (done: number, total: number) => `Verifying claims ${done}/${total}…`,
  runRendering: "Writing the timeline…",
  runReady: (posts: number | null) => (posts === null ? "Ready" : `Ready — ${enPosts(posts)}`),
  runError: "The timeline could not be prepared",
  runCancelled: "Run cancelled",
  collectRequested: "Asking the extension to collect…",
  collectCancelling: "Cancelling the collection…",
  collectProgress: (count: number, target: number) =>
    `Collecting in the browser… ${enCount(count)} / ${enPosts(target)}`,
  collectTarget: (target: number) => `Collecting ${enPosts(target)} in the browser…`,
  collectAny: "Collecting posts in the browser…",
  idle: "Idle",
  // Link line
  linkOpening: "Opening the browser link…",
  linkNoBrowser: "Browser extension not connected (open Brave/Chrome with the extension).",
  linkOne: "Browser extension connected.",
  linkMany: (hosts: number) => `${hosts} browsers connected.`,
  linkUnavailable:
    "The browser link could not be opened (is another copy of the app running?).",
  // Unfinished collections
  unfinished: (count: number, newestAt: string | null) =>
    (count === 1
      ? "1 earlier collection was not completed"
      : `${enCount(count)} earlier collections were not completed`) +
    (newestAt ? ` (latest started ${new Date(newestAt).toLocaleString("en-US")})` : "") +
    (count === 1
      ? ". Its posts stay on disk; it is not built."
      : ". Their posts stay on disk; they are not built."),
  // Buttons
  cancelRun: "Cancel run",
  cancelling: "Cancelling…",
  cancelCollection: "Cancel collection",
  buildAnyway: "Build timeline anyway",
  buildTimeline: "Build timeline",
  retrySame: "Try again with the same posts",
  rebuildSame: "Build timeline from the same posts",
  rebuildFrom: (posts: number) => `Build timeline from ${enPosts(posts)}`,
  collectNew: "Collect new timeline",
  // Collection notes (main → windows)
  extDisconnected: "The browser extension disconnected before answering.",
  runBusy: "A timeline is being prepared; wait for it or cancel it first.",
  extNotRunning:
    "The browser or the extension is not running. Open Brave/Chrome with the extension, then try again.",
  modeBOff: (target: number | null) =>
    `Automatic collection (Mode B) is off. Browse x.com/home in your browser; once ${target === null ? "enough posts are" : `${enPosts(target)} are`} collected you can build the timeline.`,
  permissionMissing:
    "The extension lacks a permission Mode B needs. Open the extension's options and turn Mode B on again.",
  startFailed: "The extension could not start collecting.",
  endedEmpty: (reason: string) => `The collection ended without any post (${enStop(reason)}).`,
  stoppedDropped: (reason: string) =>
    `The collection was stopped (${enStop(reason)}); no timeline was built.`,
  targetNotReached: (posts: number, target: number | null, reason: string) =>
    `Target not reached — the timeline uses ${enOf(posts, target)} (${enStop(reason)}).`,
  stoppedEarly: (posts: number, target: number | null, reason: string) =>
    `The collection stopped early (${enStop(reason)}) with ${enOf(posts, target)}.`,
  extNoAnswer:
    "The browser extension did not answer. Is the browser open with the extension enabled?",
  extSilent: (seconds: number, count: number | null, target: number | null) =>
    `No word from the browser extension for ${seconds} s — the collection may have stopped. Check the browser window` +
    (count === null ? "." : ` (${enOf(count, target)} so far).`),
  collectionCancelled: "Collection cancelled; no timeline was built.",
  // Collections over several feeds (X, Instagram)
  noSources:
    "Nothing to collect: X, Instagram and every custom site are off. Turn one on in Settings.",
  modeBOffFeeds: (target: number | null, feeds: CollectSource[]) =>
    `Automatic collection (Mode B) is off. Browse ${feeds.map((feed) => FEED_PLACES[feed]).join(" and ")} in your browser; once ${target === null ? "enough posts are" : `${enPosts(target)} are`} collected from each you can build the timeline.`,
  collectProgressFeeds: (feeds: FeedProgress[], target: number | null) =>
    `Collecting in the browser… ${feedCounts(feeds, target, enCount)}`,
  feedCountsLine: (feeds: FeedProgress[], target: number | null) =>
    feedCounts(feeds, target, enCount),
  feedsNotReached: (outcomes: CollectSourceOutcome[]) =>
    `Target not reached — the timeline uses ${enOutcomes(outcomes)}.`,
  feedsStoppedEarly: (outcomes: CollectSourceOutcome[]) =>
    `The collection stopped early: ${enOutcomes(outcomes)}.`,
  feedsEndedEmpty: (outcomes: CollectSourceOutcome[]) =>
    `The collection ended without any post: ${enOutcomes(outcomes)}.`,
  pendingFeeds: (mode: "A" | "B", outcomes: CollectSourceOutcome[]) =>
    mode === "A"
      ? `Collected while you browsed: ${enOutcomes(outcomes)}. Build the timeline? (Uses your claude CLI.)`
      : `The collection stopped early: ${enOutcomes(outcomes)}. Build the timeline anyway? (Uses your claude CLI.)`,
  // Run errors
  errCliNotFound:
    "The claude CLI was not found. Install Claude Code and log in, then try again.",
  errCliNotAuthenticated:
    "The claude CLI is installed but not logged in. Log in with it, then try again.",
  errCliUnexpected: "The claude CLI did not respond as expected.",
  errCliFailed: "The claude CLI call failed. The collected posts are kept; try again.",
  errInternal: "The run failed unexpectedly. The collected posts are kept; try again.",
  errSessionUnreadable: "The collected posts could not be read back from disk.",
  errWriteFailed: "The timeline could not be written to disk.",
  errLastRunFailed: "The last run failed.",
  /** A source that brought nothing (shown on the timeline page). */
  nothingFromSource: "Nothing was collected from this source.",
  /** Why a scrolled feed brought nothing (its stop). */
  sourceNotLoggedInX: "Not logged in to X in this browser.",
  sourceNotLoggedInInstagram: "Not logged in to Instagram in this browser.",
  sourceStalled: "No new posts arrived while scrolling.",
  /** Why a custom site brought nothing (its collect outcome). */
  siteError: "The site could not be reached or read.",
  siteTimeout: "The site did not answer in time.",
  siteEmpty: "The site answered, but no items were found.",
  siteSkipped: "Skipped: confirm this site's note in the extension's options.",
  // Browsers
  browserUnsupportedDefault:
    "Your default browser is not a supported Chromium browser. Pick a browser for collecting in Settings.",
  browserDefaultMissing: (family: string) =>
    `${enBrowser(family)} is your default browser but was not found on this PC. Pick a browser for collecting in Settings.`,
  browserNotInstalled: (family: string) => `${enBrowser(family)} is not installed on this PC.`,
  browserFallback: (family: string) =>
    `Collecting in the connected ${family === "other" ? "browser" : enBrowser(family)} instead.`,
  browserLaunchFailed: (family: string, exePath: string) =>
    `${enBrowser(family)} could not be started (${exePath}).`,
  browserNotLinked: (family: string) =>
    `${enBrowser(family)} was opened, but the extension did not connect in time. ` +
    `Is the No More Clickbait extension installed in ${enBrowser(family)}? ` +
    `Load it there (and register the native host for ${enBrowser(family)}), then try again.`,
  // Tray and notifications
  trayShowStatus: "Show status",
  trayQuit: "Quit",
  trayStage: (stage: RunStage) => EN_STAGES[stage],
  notifyCollected: (posts: number) => `${enPosts(posts)} collected`,
  notifyCollectedBody: "Build the timeline now? Click to open, then choose “Build timeline”.",
  notifyReady: "Your timeline is ready",
  notifyReadyBody: (posts: number) => `${enPosts(posts)}, finite by design. Click to read.`,
  notifyFailed: "timeline not prepared",
  notifyRunFailed: "The run failed.",
  notifyNotStarted: "collection not started",
  notifyOtherBrowser: "collecting in another browser",
  // Reading window
  readerTitle: "No More Clickbait — timeline",
  loading: "Loading…",
  stepDone: "Done: ",
  stepCurrent: "In progress: ",
  stepWaiting: "Up next: ",
  stepIncomplete: "Incomplete: ",
  prepCollected: "Collected",
  posts: (posts: number) => enPosts(posts),
  prepSetAside: "Ads, repeats and media-only posts set aside",
  toJudge: (posts: number) => `${enPosts(posts)} to judge`,
  prepScoring: "Claude reads and scores",
  prepScoringDetail: "One call · a few minutes",
  prepVerifying: "Checking the claims worth verifying",
  claims: (done: number, total: number) => `${done} / ${total} claims`,
  prepRendering: "Writing the timeline",
  preparingTitle: "Preparing the timeline",
  preparingLead: "You can close this window; the tray lets you know when it is ready.",
  cancel: "Cancel",
  collectingTitle: "Collecting posts",
  collectingTarget: (target: number) =>
    `The extension is collecting ${enPosts(target)} from your X timeline. The timeline is prepared on its own when it is done.`,
  collectingAny:
    "The extension is collecting posts from your X timeline. The timeline is prepared on its own when it is done.",
  collectingFeeds: (target: number | null, feeds: CollectSource[]) =>
    `The extension is collecting ${target === null ? "posts" : enPosts(target)} from each of ${feedList("en", feeds)}, one after the other. The timeline is prepared on its own when it is done.`,
  soFar: (count: number, target: number | null) => `${enOf(count, target)} so far.`,
  pendingTitle: (posts: number) => `${enPosts(posts)} collected`,
  pendingLeadA: (feeds: CollectSource[] | null) =>
    `Build the timeline from the posts collected while you browsed ${feeds === null ? "X" : feeds.length > 0 ? feedList("en", feeds) : "your custom sites"}? Claude scores and checks them; it takes a few minutes.`,
  pendingLeadB:
    "The collection stopped before its target. Build the timeline from what was collected anyway? Claude scores and checks them; it takes a few minutes.",
  notPrepared: "The timeline could not be prepared",
  keptPosts: "The collected posts are kept; trying again does not collect again.",
  tryAgain: "Try again",
  cancelledTitle: "Cancelled",
  cancelledLead: "The collected posts are kept.",
  goneTitle: "This timeline is gone",
  goneLead:
    "Its files were deleted to save space (only a few old collections are kept). You can collect a new timeline.",
  readyTitle: "Timeline ready",
  readyCount: (posts: number) => `${enPosts(posts)}.`,
  openTimeline: "Open timeline",
  emptyTitle: "No timeline yet",
  emptyLead:
    "For a new timeline the extension collects posts from your X timeline; then Claude scores and checks them.",
  // Settings window
  settingsWindowTitle: "No More Clickbait — Settings",
  settingsTitle: "Settings",
  settingsSub:
    "The same settings as the extension's options page — a change here is sent to the browser extension, and a change there shows up here. Changes are saved as you make them.",
  browserForCollecting: "Browser for collecting",
  groupSources: "Where to collect",
  groupCut: "What makes the cut",
  groupChecks: "Fact checks",
  groupModeB: "Mode B",
  groupBrowser: "Browser and language",
  groupDeveloper: "Developer",
  /** Why a field is greyed out: it only counts while another one is on. */
  appliesWhenOn: (label: string) => `Applies when “${label}” is on.`,
  browserSystemDefault: "System default browser",
  browserIsDefault: (label: string) => `${label} (system default)`,
  collectsIn: (label: string, connected: boolean) =>
    `Collections run in ${label}${connected ? " (extension connected)" : " (extension not connected right now)"}.`,
  pendingSending: "Sending the change to the extension…",
  pendingSavedHere: "Saved here — it will be applied when the browser connects.",
  modeBStayedOff:
    "Mode B stayed off: only the extension's options page can ask the browser for its “alarms” permission. Turn Mode B on there once.",
  extensionOutdated: (settings: string[]) =>
    `The browser extension is older than this app and does not know ${new Intl.ListFormat(INTL_LOCALES.en).format(settings.map((s) => `“${s}”`))}: changes to them do not reach the browser. Reload the extension on the browser's extensions page (for example brave://extensions), then make the change again.`,
  settingsUnreadable:
    "Could not read the settings — the form stays locked so nothing is overwritten. Close this window and open it again.",
  saveInvalid: "The marked fields are not saved — they keep their last valid value.",
  saving: "Saving…",
  saved: "Saved.",
  saveFailed: (error: string) => `Could not save: ${error}`,
  choiceFailed: (error: string) => `Could not save the browser choice: ${error}`,
  pickOption: "Pick one of the listed options.",
  wholeNumber: (min: number, max: number) => `Enter a whole number between ${min} and ${max}.`,
  outOfRange: "Some values are out of range.",
};

function enStop(reason: string): string {
  return EN_STOP_REASONS[reason] ?? reason;
}

/** "X and Instagram" / "X ve Instagram" */
function feedList(lang: UiLang, feeds: readonly CollectSource[]): string {
  return new Intl.ListFormat(INTL_LOCALES[lang], { type: "conjunction" }).format(
    feeds.map((feed) => FEED_NAMES[feed]),
  );
}

/** "X 120 / 250 · Instagram 0 / 250" */
function feedCounts(
  feeds: readonly FeedProgress[],
  target: number | null,
  count: (n: number) => string,
): string {
  return feeds
    .map(
      (feed) =>
        `${FEED_NAMES[feed.source]} ${count(feed.count ?? 0)}${target ? ` / ${count(target)}` : ""}`,
    )
    .join(" · ");
}

/** "X: 250 of 250 posts; Instagram: 40 of 250 posts (not logged in to Instagram …)" */
function enOutcomes(outcomes: readonly CollectSourceOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const why =
        outcome.reason === "target-reached"
          ? ""
          : ` (${(outcome.source === "instagram" ? EN_INSTAGRAM_STOP_REASONS[outcome.reason] : undefined) ?? enStop(outcome.reason)})`;
      return `${FEED_NAMES[outcome.source]}: ${enOf(outcome.uniquePostCount, outcome.target ?? null)}${why}`;
    })
    .join("; ");
}

function enOf(count: number, target: number | null): string {
  return target ? `${enCount(count)} of ${enPosts(target)}` : enPosts(count);
}

function trStop(reason: string): string {
  return TR_STOP_REASONS[reason] ?? reason;
}

function trOf(count: number, target: number | null): string {
  return target
    ? `${trCount(count)} / ${trCount(target)} gönderi`
    : `${trCount(count)} gönderi`;
}

function trOutcomes(outcomes: readonly CollectSourceOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const why =
        outcome.reason === "target-reached"
          ? ""
          : ` (${(outcome.source === "instagram" ? TR_INSTAGRAM_STOP_REASONS[outcome.reason] : undefined) ?? trStop(outcome.reason)})`;
      return `${FEED_NAMES[outcome.source]}: ${trOf(outcome.uniquePostCount, outcome.target ?? null)}${why}`;
    })
    .join("; ");
}

export type DesktopMessages = typeof en;

const tr: MessageTable<DesktopMessages> = {
  appTagline: "Akışın, süzülmüş. Sonu belli.",
  linkWaiting: "Tarayıcı eklentisi bekleniyor…",
  technicalDetail: "Teknik ayrıntı",
  openReader: "Okuma penceresini aç",
  openSettings: "Ayarlar…",
  tokenMonitor: "Token izleyici",
  statCollected: "Toplanan",
  statFilteredOut: "Elenen",
  statVerified: "Doğrulanan iddia",
  statKept: "Kalan / görülen gönderi",
  statInputTokens: "Girdi token'ı",
  statCacheTokens: "Önbellek token'ı",
  statOutputTokens: "Çıktı token'ı",
  statThinkingTokens: "Düşünme token'ı",
  statCost: "Tahmini maliyet",
  statRunTime: "Çalışma süresi",
  statStageTimes: "Aşama süreleri",
  statCollectionSpan: "Toplama süresi",
  statLastRun: "Son çalıştırma",
  never: "Hiç",
  running: "Sürüyor…",
  stageScore: (time) => `puanlama ${time}`,
  stageVerify: (time) => `doğrulama ${time}`,
  stepFilter: "Eleme",
  stepScore: "Puanlama",
  stepVerify: "Doğrulama",
  stepWrite: "Yazma",
  // Turkish keeps the noun singular after a number.
  unitPosts: (_n) => "gönderi",
  unitClaims: (_n) => "iddia",
  sitesTitle: (done, total) => `Özel siteler · ${done}/${total} bitti`,
  sitesProblems: (n) => `${trCount(n)} sorun`,
  siteStatus: (status) => TR_SITE_STATUS[status],
  siteItems: (n) => `${trCount(n)} öğe`,
  llmNotChecked: "Henüz denetlenmedi.",
  llmCheck: "claude CLI'ı denetle",
  llmChecking: "Denetleniyor…",
  llmReady: (version) => `Hazır — claude CLI ${version}`,
  llmNotFound: "claude CLI PATH'te bulunamadı. Kurup oturum aç, sonra yeniden denetle.",
  llmNotAuthenticated: "claude CLI kurulu ama oturum açılmamış. Önce CLI ile oturum aç.",
  llmFailed: (detail) => `CLI denetimi başarısız: ${detail}`,
  failed: (error) => `Başarısız: ${error}`,
  pendingModeA: (posts) =>
    `Sen gezinirken ${trCount(posts)} gönderi toplandı. Akış oluşturulsun mu? (claude CLI'ını kullanır.)`,
  pendingModeB: (reason, posts) =>
    `Toplama erken durdu (${trStop(reason)}); ${trCount(posts)} gönderi var. Akış yine de oluşturulsun mu? (claude CLI'ını kullanır.)`,
  seconds: (s) => `${s} sn`,
  minutes: (m) => `${m} dk`,
  minutesSeconds: (m, s) => `${m} dk ${s} sn`,
  runChecking: "claude CLI denetleniyor…",
  runFiltering: "Reklam ve tekrarlar ayıklanıyor…",
  runScoring: (posts) =>
    posts === null ? "Gönderiler puanlanıyor…" : `${trCount(posts)} gönderi puanlanıyor…`,
  runVerifying: (done, total) => `İddialar doğrulanıyor ${done}/${total}…`,
  runRendering: "Akış yazılıyor…",
  runReady: (posts) => (posts === null ? "Hazır" : `Hazır — ${trCount(posts)} gönderi`),
  runError: "Akış hazırlanamadı",
  runCancelled: "Çalıştırma iptal edildi",
  collectRequested: "Eklentiden toplaması isteniyor…",
  collectCancelling: "Toplama iptal ediliyor…",
  collectProgress: (count, target) =>
    `Tarayıcıda toplanıyor… ${trCount(count)} / ${trCount(target)} gönderi`,
  collectTarget: (target) => `Tarayıcıda ${trCount(target)} gönderi toplanıyor…`,
  collectAny: "Tarayıcıda gönderiler toplanıyor…",
  idle: "Boşta",
  linkOpening: "Tarayıcı bağlantısı açılıyor…",
  linkNoBrowser: "Tarayıcı eklentisi bağlı değil (Brave/Chrome'u eklentiyle aç).",
  linkOne: "Tarayıcı eklentisi bağlı.",
  linkMany: (hosts) => `${hosts} tarayıcı bağlı.`,
  linkUnavailable:
    "Tarayıcı bağlantısı açılamadı (uygulamanın başka bir kopyası mı çalışıyor?).",
  unfinished: (count, newestAt) =>
    `Daha önceki ${trCount(count)} toplama tamamlanmadı` +
    (newestAt
      ? ` (sonuncusu ${new Date(newestAt).toLocaleString("tr-TR")} tarihinde başladı)`
      : "") +
    ". Gönderileri diskte duruyor; akışa dönüştürülmedi.",
  cancelRun: "Çalıştırmayı iptal et",
  cancelling: "İptal ediliyor…",
  cancelCollection: "Toplamayı iptal et",
  buildAnyway: "Akışı yine de oluştur",
  buildTimeline: "Akışı oluştur",
  retrySame: "Aynı gönderilerle tekrar dene",
  rebuildSame: "Aynı gönderilerden akış oluştur",
  rebuildFrom: (posts) => `${trCount(posts)} gönderiden akış oluştur`,
  collectNew: "Yeni akış topla",
  extDisconnected: "Tarayıcı eklentisi yanıt vermeden bağlantıyı kesti.",
  runBusy: "Bir akış hazırlanıyor; bitmesini bekle ya da önce onu iptal et.",
  extNotRunning:
    "Tarayıcı ya da eklenti çalışmıyor. Brave/Chrome'u eklentiyle aç, sonra tekrar dene.",
  modeBOff: (target) =>
    `Otomatik toplama (B modu) kapalı. Tarayıcında x.com/home'da gezin; ${target === null ? "yeterli gönderi" : `${trCount(target)} gönderi`} toplanınca akışı oluşturabilirsin.`,
  permissionMissing:
    "Eklentide B modunun gerektirdiği bir izin eksik. Eklentinin seçeneklerini açıp B modunu yeniden aç.",
  startFailed: "Eklenti toplamaya başlayamadı.",
  endedEmpty: (reason) => `Toplama hiç gönderi olmadan bitti (${trStop(reason)}).`,
  stoppedDropped: (reason) => `Toplama durduruldu (${trStop(reason)}); akış oluşturulmadı.`,
  targetNotReached: (posts, target, reason) =>
    `Hedefe ulaşılamadı — akış ${trOf(posts, target)} ile oluşturuluyor (${trStop(reason)}).`,
  stoppedEarly: (posts, target, reason) =>
    `Toplama erken durdu (${trStop(reason)}); ${trOf(posts, target)} var.`,
  extNoAnswer: "Tarayıcı eklentisi yanıt vermedi. Tarayıcı eklenti etkinken açık mı?",
  extSilent: (seconds, count, target) =>
    `Tarayıcı eklentisinden ${seconds} sn'dir ses yok — toplama durmuş olabilir. Tarayıcı penceresine bak` +
    (count === null ? "." : ` (şu ana kadar ${trOf(count, target)}).`),
  collectionCancelled: "Toplama iptal edildi; akış oluşturulmadı.",
  noSources:
    "Toplanacak bir şey yok: X, Instagram ve tüm özel siteler kapalı. Ayarlar'da birini aç.",
  modeBOffFeeds: (target, feeds) =>
    `Otomatik toplama (B modu) kapalı. Tarayıcında ${feeds.map((feed) => FEED_PLACES[feed]).join(" ve ")} adreslerinde gezin; her birinden ${target === null ? "yeterli gönderi" : `${trCount(target)} gönderi`} toplanınca akışı oluşturabilirsin.`,
  collectProgressFeeds: (feeds, target) =>
    `Tarayıcıda toplanıyor… ${feedCounts(feeds, target, trCount)}`,
  feedCountsLine: (feeds, target) => feedCounts(feeds, target, trCount),
  feedsNotReached: (outcomes) =>
    `Hedefe ulaşılamadı — akış şunlarla oluşturuluyor: ${trOutcomes(outcomes)}.`,
  feedsStoppedEarly: (outcomes) => `Toplama erken durdu: ${trOutcomes(outcomes)}.`,
  feedsEndedEmpty: (outcomes) => `Toplama hiç gönderi olmadan bitti: ${trOutcomes(outcomes)}.`,
  pendingFeeds: (mode, outcomes) =>
    mode === "A"
      ? `Sen gezinirken toplandı: ${trOutcomes(outcomes)}. Akış oluşturulsun mu? (claude CLI'ını kullanır.)`
      : `Toplama erken durdu: ${trOutcomes(outcomes)}. Akış yine de oluşturulsun mu? (claude CLI'ını kullanır.)`,
  errCliNotFound: "claude CLI bulunamadı. Claude Code'u kurup oturum aç, sonra tekrar dene.",
  errCliNotAuthenticated:
    "claude CLI kurulu ama oturum açılmamış. Onunla oturum aç, sonra tekrar dene.",
  errCliUnexpected: "claude CLI beklendiği gibi yanıt vermedi.",
  errCliFailed: "claude CLI çağrısı başarısız oldu. Toplanan gönderiler duruyor; tekrar dene.",
  errInternal:
    "Çalıştırma beklenmedik biçimde başarısız oldu. Toplanan gönderiler duruyor; tekrar dene.",
  errSessionUnreadable: "Toplanan gönderiler diskten geri okunamadı.",
  errWriteFailed: "Akış diske yazılamadı.",
  errLastRunFailed: "Son çalıştırma başarısız oldu.",
  nothingFromSource: "Bu kaynaktan hiçbir şey toplanmadı.",
  sourceNotLoggedInX: "Bu tarayıcıda X oturumu açık değil.",
  sourceNotLoggedInInstagram: "Bu tarayıcıda Instagram oturumu açık değil.",
  sourceStalled: "Kaydırırken yeni gönderi gelmedi.",
  siteError: "Siteye ulaşılamadı ya da site okunamadı.",
  siteTimeout: "Site zamanında yanıt vermedi.",
  siteEmpty: "Site yanıt verdi ama hiç öğe bulunamadı.",
  siteSkipped: "Atlandı: eklenti ayarlarında bu sitenin notunu onayla.",
  browserUnsupportedDefault:
    "Varsayılan tarayıcın desteklenen bir Chromium tarayıcısı değil. Ayarlar'da toplama için bir tarayıcı seç.",
  browserDefaultMissing: (family) =>
    `${trBrowser(family)} varsayılan tarayıcın ama bu bilgisayarda bulunamadı. Ayarlar'da toplama için bir tarayıcı seç.`,
  browserNotInstalled: (family) => `${trBrowser(family)} bu bilgisayarda kurulu değil.`,
  browserFallback: (family) =>
    `Onun yerine bağlı ${family === "other" ? "tarayıcıda" : `${trBrowser(family)} tarayıcısında`} toplanıyor.`,
  browserLaunchFailed: (family, exePath) => `${trBrowser(family)} başlatılamadı (${exePath}).`,
  browserNotLinked: (family) =>
    `${trBrowser(family)} açıldı ama eklenti zamanında bağlanmadı. ` +
    `No More Clickbait eklentisi ${trBrowser(family)} tarayıcısında kurulu mu? ` +
    `Eklentiyi orada yükle (ve yerel ana makineyi ${trBrowser(family)} için kaydet), sonra tekrar dene.`,
  trayShowStatus: "Durumu göster",
  trayQuit: "Çık",
  trayStage: (stage) => TR_STAGES[stage],
  notifyCollected: (posts) => `${trCount(posts)} gönderi toplandı`,
  notifyCollectedBody:
    "Akış şimdi oluşturulsun mu? Açmak için tıkla, sonra “Akışı oluştur”u seç.",
  notifyReady: "Akışın hazır",
  notifyReadyBody: (posts) => `${trCount(posts)} gönderi, sonu belli. Okumak için tıkla.`,
  notifyFailed: "akış hazırlanamadı",
  notifyRunFailed: "Çalıştırma başarısız oldu.",
  notifyNotStarted: "toplama başlamadı",
  notifyOtherBrowser: "başka bir tarayıcıda toplanıyor",
  readerTitle: "No More Clickbait — akış",
  loading: "Yükleniyor…",
  stepDone: "Tamam: ",
  stepCurrent: "Sürüyor: ",
  stepWaiting: "Sırada: ",
  stepIncomplete: "Eksik: ",
  prepCollected: "Toplandı",
  posts: (posts) => `${posts} gönderi`,
  prepSetAside: "Reklam, tekrar ve yalnız-medya ayrıldı",
  toJudge: (posts) => `${posts} gönderi değerlendirilecek`,
  prepScoring: "Claude okuyor ve puanlıyor",
  prepScoringDetail: "Tek çağrı · birkaç dakika",
  prepVerifying: "Doğrulamaya değer iddialar kontrol ediliyor",
  claims: (done, total) => `${done} / ${total} iddia`,
  prepRendering: "Akış yazılıyor",
  preparingTitle: "Akış hazırlanıyor",
  preparingLead: "Bu pencereyi kapatabilirsin; hazır olunca tepsiden haber verilir.",
  cancel: "İptal",
  collectingTitle: "Gönderiler toplanıyor",
  collectingTarget: (target) =>
    `Eklenti X akışından ${target} gönderi topluyor. Bitince akış kendiliğinden hazırlanır.`,
  collectingAny: "Eklenti X akışından gönderi topluyor. Bitince akış kendiliğinden hazırlanır.",
  collectingFeeds: (target, feeds) =>
    `Eklenti ${feedList("tr", feeds)} akışlarının her birinden sırayla ${target === null ? "gönderi" : `${trCount(target)} gönderi`} topluyor. Bitince akış kendiliğinden hazırlanır.`,
  soFar: (count, target) => `Şu ana kadar ${count}${target ? ` / ${target}` : ""} gönderi.`,
  pendingTitle: (posts) => `${posts} gönderi toplandı`,
  pendingLeadA: (feeds) =>
    `${feeds === null ? "X'te" : feeds.length > 0 ? `${feedList("tr", feeds)}${TR_LOCATIVE[feeds.at(-1) ?? "x"]}` : "Özel sitelerinde"} gezinirken toplanan gönderilerden akışı oluşturalım mı? Claude puanlar ve doğrular; birkaç dakika sürer.`,
  pendingLeadB:
    "Toplama hedefe ulaşmadan durdu. Toplananlarla akışı yine de oluşturalım mı? Claude puanlar ve doğrular; birkaç dakika sürer.",
  notPrepared: "Akış hazırlanamadı",
  keptPosts: "Toplanan gönderiler duruyor; yeniden denemek için yeniden toplamak gerekmez.",
  tryAgain: "Tekrar dene",
  cancelledTitle: "İptal edildi",
  cancelledLead: "Toplanan gönderiler duruyor.",
  goneTitle: "Akış artık yok",
  goneLead:
    "Bu akışın dosyaları yer açmak için silindi (eski toplamalar sınırlı sayıda saklanır). Yeni bir akış toplayabilirsin.",
  readyTitle: "Akış hazır",
  readyCount: (posts) => `${posts} gönderi.`,
  openTimeline: "Akışı aç",
  emptyTitle: "Henüz akış yok",
  emptyLead:
    "Yeni bir akış için eklenti X akışından gönderi toplar; sonra Claude puanlar ve doğrular.",
  settingsWindowTitle: "No More Clickbait — Ayarlar",
  settingsTitle: "Ayarlar",
  settingsSub:
    "Eklentinin seçenekler sayfasındaki ayarların aynısı — burada yapılan değişiklik tarayıcı eklentisine gönderilir, orada yapılan burada görünür. Değişiklikler yapıldığı anda kaydedilir.",
  browserForCollecting: "Toplama tarayıcısı",
  groupSources: "Nereden toplanır",
  groupCut: "Akışa ne girer",
  groupChecks: "Doğruluk kontrolleri",
  groupModeB: "B modu",
  groupBrowser: "Tarayıcı ve dil",
  groupDeveloper: "Geliştirici",
  appliesWhenOn: (label) => `“${label}” açıkken geçerli.`,
  browserSystemDefault: "Sistemin varsayılan tarayıcısı",
  browserIsDefault: (label) => `${label} (sistem varsayılanı)`,
  collectsIn: (label, connected) =>
    `Toplamalar ${label} tarayıcısında yapılır${connected ? " (eklenti bağlı)" : " (eklenti şu an bağlı değil)"}.`,
  pendingSending: "Değişiklik eklentiye gönderiliyor…",
  pendingSavedHere: "Burada kaydedildi — tarayıcı bağlanınca uygulanacak.",
  modeBStayedOff:
    "B modu kapalı kaldı: tarayıcıdan “alarms” iznini yalnız eklentinin seçenekler sayfası isteyebilir. B modunu bir kez orada aç.",
  extensionOutdated: (settings) =>
    `Tarayıcı eklentisi bu uygulamadan eski ve ${new Intl.ListFormat(INTL_LOCALES.tr).format(settings.map((s) => `“${s}”`))} ayarlarını bilmiyor: bunlardaki değişiklik tarayıcıya ulaşmaz. Eklentiyi tarayıcının uzantılar sayfasında (örneğin brave://extensions) yeniden yükle, sonra değişikliği tekrar yap.`,
  settingsUnreadable:
    "Ayarlar okunamadı — hiçbir şeyin üzerine yazılmasın diye form kilitli. Bu pencereyi kapatıp yeniden aç.",
  saveInvalid: "İşaretli alanlar kaydedilmedi — son geçerli değerleri duruyor.",
  saving: "Kaydediliyor…",
  saved: "Kaydedildi.",
  saveFailed: (error) => `Kaydedilemedi: ${error}`,
  choiceFailed: (error) => `Tarayıcı seçimi kaydedilemedi: ${error}`,
  pickOption: "Listedeki seçeneklerden birini seç.",
  wholeNumber: (min, max) => `${min} ile ${max} arasında bir tam sayı gir.`,
  outOfRange: "Bazı değerler aralığın dışında.",
};

export const DESKTOP_MESSAGES: Readonly<Record<UiLang, DesktopMessages>> = { en, tr };

/** A message main sends to the windows: key + plain-data arguments. */
export type Note = MessageRef<DesktopMessages>;

type Args<K extends keyof DesktopMessages> = DesktopMessages[K] extends (
  ...args: infer A
) => string
  ? A
  : [];

/** Builds a `Note` (arguments type-checked against the English table). */
export function note<K extends keyof DesktopMessages & string>(key: K, ...args: Args<K>): Note {
  return (args.length > 0 ? { key, args } : { key }) as Note;
}

/** The words for `lang`. */
export function messages(lang: UiLang): DesktopMessages {
  return DESKTOP_MESSAGES[lang];
}

/** A note in words (null stays empty). */
export function say(lang: UiLang, value: Note | null): string {
  return value === null ? "" : formatMessage(DESKTOP_MESSAGES[lang], value);
}

/** The run-error notes, for reading back a failed run's saved (English) message. */
const RUN_ERROR_KEYS = [
  "errCliNotFound",
  "errCliNotAuthenticated",
  "errCliUnexpected",
  "errCliFailed",
  "errInternal",
  "errSessionUnreadable",
  "errWriteFailed",
] as const;

/**
 * A failed run is saved with its note's key and English message
 * (processed.json); this finds its note again so the window can show it
 * in either language. Records from before the key was saved match on
 * the English message.
 */
export function runErrorNote(
  saved: { note?: string | undefined; message?: string | undefined } | undefined,
): Note {
  const key =
    RUN_ERROR_KEYS.find((candidate) => candidate === saved?.note) ??
    RUN_ERROR_KEYS.find((candidate) => en[candidate] === saved?.message);
  return note(key ?? "errLastRunFailed");
}
