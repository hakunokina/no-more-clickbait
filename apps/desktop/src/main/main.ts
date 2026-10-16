import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ManagedSettingsSchema,
  resolveUiLang,
  type ManagedSettings,
  type UiLang,
} from "@nmc/core";
import { createClaudeCliProvider, type LlmAvailability } from "@nmc/core/llm";
import {
  desktopDataDir,
  desktopPipePath,
  LinkServer,
  pruneSessions,
  sessionsRoot,
  writeLinkToken,
  type DesktopCommand,
} from "@nmc/native-host";
import { NMC_IMAGE_SCHEME, renderTimeline } from "@nmc/timeline-renderer";
import { messages, note, say } from "../shared/i18n.js";
import type { BrowserChoice, SettingsStatus } from "../shared/settings-status.js";
import { isRunActive, type DesktopStatus, type RunStage } from "../shared/status.js";
import { READER_PAGE_ARG } from "../preload/reader-bridge.js";
import {
  browserLabel,
  hostMatchesBrowser,
  loadBrowserChoice,
  parseBrowserChoice,
  resolveCollectBrowser,
  saveBrowserChoice,
  type CollectBrowserResolution,
} from "./browser-choice.js";
import { createClaudeStages } from "./claude-stages.js";
import { ensureCollectBrowser } from "./ensure-browser.js";
import { fetchImage } from "./image-fetch.js";
import { ipcAllowed } from "./ipc-policy.js";
import { PipelineRunner } from "./pipeline-runner.js";
import { ReaderImages, timelineImageSources } from "./reader-images.js";
import { ReadingWindow } from "./reading-window.js";
import { SessionController } from "./session-controller.js";
import { loadDesktopSettings } from "./settings-file.js";
import { liveContents, sendToAll } from "./window-contents.js";
import { SettingsManager } from "./settings-manager.js";
import { FlushBeforeClose, requestFlush } from "./settings-close.js";
import {
  defaultBrowserFamily,
  installedBrowsers,
  launchDetached,
  regExeReader,
  waitForConnection,
  type InstalledBrowser,
} from "./windows-browsers.js";

/**
 * Desktop shell: lives in the system tray with a compact "token monitor"
 * window and a reading window. Security posture is strict: sandbox on,
 * context isolation on, node integration off, a narrow preload bridge
 * per window (none at all for a timeline page's main world), no remote
 * content except the allow-listed feed media in the reading window
 * (generic cards' images are fetched here and served as nmc-img:).
 *
 * Wiring: the browser-launched native host connects over the user-only
 * link pipe (see @nmc/native-host desktop-link.ts); collected posts are
 * read from the session folders on disk; SessionController runs the
 * pipeline (claude CLI) and writes the timeline the reading window shows.
 * Diagnostics go to stderr and carry counts only, never feed content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "renderer");
const preload = join(here, "preload.cjs");
const readerPage = join(rendererDir, "reader.html");
const readerPageUrl = pathToFileURL(readerPage).href;
const root = sessionsRoot();

// Secrets (future providers) go through ./electron-secret-store.ts
// (Electron safeStorage). Phase 1 needs none: the CLI owns its auth.

function log(line: string): void {
  process.stderr.write(`[nmc] ${line}\n`);
}

if (!app.requestSingleInstanceLock()) {
  // The pipe and the session folders belong to one instance only.
  app.exit(0);
}
app.setAppUserModelId("io.github.hakunokina.no-more-clickbait");
// Before ready: a standard, secure scheme the reading window's session serves alone.
protocol.registerSchemesAsPrivileged([
  { scheme: NMC_IMAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

let monitor: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/** Holds the Settings window's close (and an app quit) until its page saved. */
let settingsClose: FlushBeforeClose | null = null;
let tray: Tray | null = null;
let link: LinkServer | null = null;
let lastStage: RunStage = "idle";
/** The windows' language: the Settings choice, "system" resolved against the OS. */
let lang: UiLang = "en";

// "Browser for collecting": the saved choice resolved against this PC
// (system default + installed browsers) at start-up and on change.
let browserChoice: BrowserChoice = "default";
let systemDefaultBrowser: InstalledBrowser["family"] | null = null;
let installed: InstalledBrowser[] = [];
let collectBrowser: CollectBrowserResolution | null = null;

/** The browser collections and settings go to, when one resolved. */
function resolvedBrowser(): InstalledBrowser | null {
  return collectBrowser?.ok ? collectBrowser.browser : null;
}

/** A host of the resolved browser is linked (any host, when none resolved). */
function collectBrowserConnected(): boolean {
  if (!link) return false;
  const browser = resolvedBrowser();
  return browser
    ? link.hosts.some((host) => hostMatchesBrowser(host.browser, browser))
    : link.hostCount > 0;
}

/** Link sends, narrowed to the resolved browser's host when there is one. */
function sendToCollectBrowser(command: DesktopCommand): boolean {
  if (!link) return false;
  const browser = resolvedBrowser();
  return browser
    ? link.send(command, (host) => hostMatchesBrowser(host.browser, browser))
    : link.send(command);
}

const settingsManager = new SettingsManager({
  sendPush: (settings, stamp) =>
    sendToCollectBrowser({ type: "settings-push", settings, stamp }),
  onState: () => {
    applyLanguage();
    broadcastSettings();
  },
});

/** Follows the Settings' language: windows (via status), tray, the open timeline. */
function applyLanguage(): void {
  const next = resolveUiLang(
    settingsManager.state.settings.uiLanguage,
    app.isReady() ? app.getPreferredSystemLanguages() : [],
  );
  if (next === lang) return;
  lang = next;
  sendLangToExtensions();
  if (tray) setTrayMenu();
  void controller.setLang(next).catch((error: unknown) => log(`language: ${String(error)}`));
}

/**
 * Every linked extension shows this language when it is set to
 * "system": the OS's language is known here, not to the browser (whose
 * own language may be any other).
 */
function sendLangToExtensions(): void {
  link?.broadcast({ type: "ui-lang", lang });
}

function settingsStatus(): SettingsStatus {
  const state = settingsManager.state;
  const resolved = resolvedBrowser();
  return {
    lang,
    settings: state.settings,
    stamp: state.stamp,
    pending: state.pending,
    browserConnected: state.browserConnected,
    modeBPermissionMissing: state.modeBPermissionMissing,
    extensionMissing: state.extensionMissing,
    choice: browserChoice,
    browsers: installed.map((browser) => ({
      family: browser.family,
      label: browserLabel(browser.family),
      systemDefault: browser.family === systemDefaultBrowser,
    })),
    collectBrowserLabel: resolved ? browserLabel(resolved.family) : null,
    collectBrowserProblem: collectBrowser && !collectBrowser.ok ? collectBrowser.reason : null,
  };
}

function broadcastSettings(): void {
  const status = settingsStatus();
  for (const contents of [monitor?.webContents, settingsWindow?.webContents]) {
    if (contents && !contents.isDestroyed()) contents.send("nmc:settings-status", status);
  }
}

/** Re-reads the default/installed browsers and re-resolves the choice. */
async function refreshBrowsers(): Promise<void> {
  if (process.platform === "win32") {
    const reader = regExeReader();
    [systemDefaultBrowser, installed] = await Promise.all([
      defaultBrowserFamily(reader).catch(() => null),
      installedBrowsers(reader).catch(() => [] as InstalledBrowser[]),
    ]);
  }
  collectBrowser = resolveCollectBrowser(browserChoice, systemDefaultBrowser, installed);
  settingsManager.setBrowserConnected(collectBrowserConnected());
  broadcastSettings();
}

// Kept apart from the session folders (pruned with them otherwise, and the page may read those).
const images = new ReaderImages({
  cacheDir: join(desktopDataDir(), "image-cache"),
  fetchImage: (url) => fetchImage(url, { userAgent: app.userAgentFallback }),
  log,
});

const reader = new ReadingWindow({
  preload: join(here, "reader-preload.cjs"),
  preloadArguments: [`${READER_PAGE_ARG}${readerPageUrl}`],
  appPage: readerPage,
  fileRoots: [rendererDir, root],
  images: {
    scheme: NMC_IMAGE_SCHEME,
    handle: (request) => images.respond(request.url),
    show: (timelinePath) =>
      images.allow(timelinePath ? timelineImageSources(timelinePath) : new Map()),
  },
});

const controller = new SessionController({
  sessionsRoot: root,
  runner: new PipelineRunner(createClaudeStages),
  loadSettings: () => loadDesktopSettings(undefined, log),
  // Buttons in the page ("Collect new timeline") are handled by the preload.
  renderTimeline: (doc, pageLang) =>
    renderTimeline(doc, { actions: true, lang: pageLang, imageMode: "desktop" }),
  sendToHost: (command) => sendToCollectBrowser(command),
  onStatus: broadcast,
  onAwaitingConfirmation: ({ uniquePostCount }) => {
    const m = messages(lang);
    notify(m.notifyCollected(uniquePostCount), m.notifyCollectedBody, () => void openReader());
  },
  onReady: ({ timelinePath, selected }) => {
    if (reader.timelineReady(timelinePath)) return;
    const m = messages(lang);
    notify(m.notifyReady, m.notifyReadyBody(selected), () => reader.open(timelinePath));
  },
  onTimelineRewritten: (timelinePath) => reader.reloadTimeline(timelinePath),
  log,
});

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: `No More Clickbait — ${title}`, body });
  if (onClick) notification.on("click", onClick);
  notification.show();
}

function broadcast(status: DesktopStatus): void {
  sendToAll([liveContents(monitor), reader.webContents], "nmc:status", status, log);
  const m = messages(status.lang);
  tray?.setToolTip(`No More Clickbait — ${m.trayStage(status.run.stage)}`);
  const stage = status.run.stage;
  if (stage === "error" && lastStage !== "error" && !reader.webContents) {
    const error = status.run.error;
    notify(
      m.notifyFailed,
      error ? say(status.lang, error.note) : m.notifyRunFailed,
      () => void openReader(),
    );
  }
  lastStage = stage;
}

/** Opens the timeline, or our status page (preparing, error, timeline gone…). */
async function openReader(): Promise<void> {
  const status = controller.status;
  const showTimeline = !isRunActive(status.run.stage) && status.run.hasTimeline;
  reader.open(showTimeline ? await controller.availableTimeline() : null);
}

/**
 * The windows' page colour (renderer CSS `--bg`), so a dark window does
 * not flash white before its page paints.
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#171513" : "#faf7f2";
}

function createMonitor(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 640,
    resizable: false,
    show: false,
    title: "No More Clickbait",
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // The renderer is local-only; refuse navigation and new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  win.on("closed", () => {
    if (monitor === win) monitor = null;
  });
  void win.loadFile(join(rendererDir, "index.html"));
  return win;
}

function showMonitor(): void {
  if (!monitor || monitor.isDestroyed()) monitor = createMonitor();
  monitor.show();
  monitor.focus();
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: messages(lang).settingsWindowTitle,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // Changes save as they are made; one still typed is saved before the window goes.
  const contents = win.webContents;
  const close = new FlushBeforeClose(
    () =>
      contents.isDestroyed() || contents.isCrashed()
        ? Promise.resolve()
        : requestFlush({
            request: () => contents.send("nmc:flush-settings"),
            onDone(listener) {
              const onFlushed = (event: IpcMainEvent): void => {
                if (event.sender === contents) listener();
              };
              ipcMain.on("nmc:settings-flushed", onFlushed);
              return () => ipcMain.off("nmc:settings-flushed", onFlushed);
            },
          }),
    () => {
      if (!win.isDestroyed()) win.close();
    },
  );
  settingsClose = close;
  win.on("close", (event) => close.hold(event));
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
    if (settingsClose === close) settingsClose = null;
  });

  void win.loadFile(join(rendererDir, "settings.html"));
  return win;
}

function showSettings(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createSettingsWindow();
    settingsWindow.once("ready-to-show", () => {
      settingsWindow?.show();
      broadcastSettings();
    });
    return;
  }
  settingsWindow.show();
  settingsWindow.focus();
  broadcastSettings();
}

function toggleMonitor(): void {
  if (monitor && !monitor.isDestroyed() && monitor.isVisible()) monitor.hide();
  else showMonitor();
}

async function startCollection(): Promise<void> {
  reader.expectTimeline();
  // The chosen browser must be up with its extension linked; an
  // unresolvable choice falls back to whichever extension is linked
  // (the any-host send picks the newest host) and says so.
  if (collectBrowser) {
    const ensured = await ensureCollectBrowser({
      resolution: collectBrowser,
      isConnected: (browser) =>
        link?.hosts.some((host) => hostMatchesBrowser(host.browser, browser)) ?? false,
      launch: launchDetached,
      waitForConnection: (check) => waitForConnection(check),
      anyConnected: () => link?.hosts.at(-1)?.browser.family ?? null,
    });
    const m = messages(lang);
    if (!ensured.ok) {
      log(`collection not started: ${ensured.reason.key}`);
      notify(m.notifyNotStarted, say(lang, ensured.reason), showMonitor);
      return;
    }
    if (ensured.notice) {
      const notice = ensured.notice.map((part) => say(lang, part)).join(" ");
      notify(m.notifyOtherBrowser, notice, showMonitor);
    }
    if (ensured.launched) settingsManager.setBrowserConnected(collectBrowserConnected());
  }
  return controller.startCollection();
}

function createTray(): void {
  // 1x1 transparent placeholder until real icons land.
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  );
  tray = new Tray(icon);
  tray.setToolTip("No More Clickbait");
  setTrayMenu();
  tray.on("click", toggleMonitor);
}

/** The tray menu in the current language. */
function setTrayMenu(): void {
  const m = messages(lang);
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: m.collectNew, click: () => void startCollection() },
      { label: m.openReader, click: () => void openReader() },
      { label: m.trayShowStatus, click: showMonitor },
      { label: m.openSettings, click: showSettings },
      { type: "separator" },
      { label: m.trayQuit, click: () => app.quit() },
    ]),
  );
}

/** Only our own windows may call into main, each within ipc-policy.ts. */
function callerAllowed(channel: string, event: IpcMainInvokeEvent): boolean {
  const sender = event.sender;
  const window =
    sender === liveContents(monitor)
      ? "monitor"
      : sender === liveContents(settingsWindow)
        ? "settings"
        : sender === reader.webContents
          ? "reader"
          : null;
  return ipcAllowed(channel, window, event.senderFrame?.url ?? null, readerPageUrl);
}

function handle<T>(channel: string, fn: () => T | Promise<T>): void {
  ipcMain.handle(channel, (event) => {
    if (!callerAllowed(channel, event)) throw new Error("unexpected IPC sender");
    return fn();
  });
}

handle("nmc:llm-status", (): Promise<LlmAvailability> =>
  createClaudeCliProvider().checkAvailable(),
);
handle("nmc:get-status", () => controller.status);
handle("nmc:start-collection", startCollection);
handle("nmc:cancel-run", () => controller.cancel());
handle("nmc:retry-run", () => {
  reader.expectTimeline();
  return controller.retry();
});
handle("nmc:build-timeline", () => {
  reader.expectTimeline();
  return controller.buildPending();
});
handle("nmc:open-reader", openReader);
handle("nmc:get-settings-status", () => settingsStatus());
handle("nmc:open-settings", showSettings);

function handleArg<T>(channel: string, fn: (arg: unknown) => T | Promise<T>): void {
  ipcMain.handle(channel, (event, arg: unknown) => {
    if (!callerAllowed(channel, event)) throw new Error("unexpected IPC sender");
    return fn(arg);
  });
}

// Settings cross the bridge unvalidated; core's schema is the gate.
handleArg("nmc:update-settings", (arg) => {
  const settings: ManagedSettings = ManagedSettingsSchema.parse(arg);
  return settingsManager.change(settings);
});
handleArg("nmc:set-browser-choice", async (arg) => {
  browserChoice = parseBrowserChoice({ choice: arg });
  await saveBrowserChoice(browserChoice);
  await refreshBrowsers();
});

async function startLink(): Promise<void> {
  try {
    const token = await writeLinkToken();
    link = new LinkServer({
      path: desktopPipePath(),
      token,
      onEvent: (event, from) => {
        if (event.type === "settings-state") {
          // Only the collecting browser's extension owns the settings.
          const browser = resolvedBrowser();
          if (!browser || hostMatchesBrowser(from.browser, browser)) {
            void settingsManager
              .handleSettingsState(event)
              .catch((error: unknown) => log(`settings state: ${String(error)}`));
          }
          return;
        }
        controller.handleHostEvent(event);
      },
      onHostsChanged: (hosts) => {
        controller.setLink({ hosts });
        sendLangToExtensions();
        settingsManager.setBrowserConnected(collectBrowserConnected());
      },
    });
    await link.listen();
    controller.setLink({ listening: true, error: null });
  } catch (error) {
    link = null;
    log(`link pipe unavailable: ${String(error)}`);
    controller.setLink({
      listening: false,
      error: note("linkUnavailable"),
    });
  }
}

app.on("second-instance", showMonitor);

void app.whenReady().then(async () => {
  createTray();
  monitor = createMonitor();
  monitor.once("ready-to-show", () => monitor?.show());
  await pruneSessions(root).catch(() => undefined);
  browserChoice = await loadBrowserChoice();
  await settingsManager.init().catch((error: unknown) => log(`settings: ${String(error)}`));
  // Also when init failed (no state push): a "system" user still gets the OS language.
  applyLanguage();
  await refreshBrowsers().catch((error: unknown) => log(`browsers: ${String(error)}`));
  await startLink();
  // A collection may have finished while the app was closed.
  await controller
    .processPending()
    .catch((error: unknown) => log(`pending sessions: ${String(error)}`));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showMonitor();
  });
});

app.on("before-quit", (event) => {
  // The Settings page saves what waits first; the quit then goes on.
  if (settingsClose && !settingsClose.flushed) {
    settingsClose.hold(event, () => app.quit());
    return;
  }
  controller.cancel();
  void link?.close();
});

// Tray app: closing the windows must not quit the process.
app.on("window-all-closed", () => {
  // Intentionally empty.
});
