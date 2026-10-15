import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ManagedSettingsSchema, type ManagedSettings } from "@nmc/core";
import { createClaudeCliProvider, type LlmAvailability } from "@nmc/core/llm";
import {
  desktopPipePath,
  LinkServer,
  pruneSessions,
  sessionsRoot,
  writeLinkToken,
  type DesktopCommand,
} from "@nmc/native-host";
import { renderTimeline } from "@nmc/timeline-renderer";
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
import { ipcAllowed } from "./ipc-policy.js";
import { PipelineRunner } from "./pipeline-runner.js";
import { ReadingWindow } from "./reading-window.js";
import { SessionController } from "./session-controller.js";
import { loadDesktopSettings } from "./settings-file.js";
import { SettingsManager } from "./settings-manager.js";
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
 * content except the allow-listed feed media in the reading window.
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

let monitor: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let link: LinkServer | null = null;
let lastStage: RunStage = "idle";

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
  sendPush: (settings, stamp) => sendToCollectBrowser({ type: "settings-push", settings, stamp }),
  onState: () => broadcastSettings(),
});

function settingsStatus(): SettingsStatus {
  const state = settingsManager.state;
  const resolved = resolvedBrowser();
  return {
    settings: state.settings,
    stamp: state.stamp,
    pending: state.pending,
    browserConnected: state.browserConnected,
    modeBPermissionMissing: state.modeBPermissionMissing,
    choice: browserChoice,
    browsers: installed.map((browser) => ({
      family: browser.family,
      label: browserLabel(browser.family),
      systemDefault: browser.family === systemDefaultBrowser,
    })),
    collectBrowserLabel: resolved ? browserLabel(resolved.family) : null,
    collectBrowserProblem:
      collectBrowser && !collectBrowser.ok ? collectBrowser.reason : null,
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

const reader = new ReadingWindow({
  preload: join(here, "reader-preload.cjs"),
  preloadArguments: [`${READER_PAGE_ARG}${readerPageUrl}`],
  appPage: readerPage,
  fileRoots: [rendererDir, root],
});

const controller = new SessionController({
  sessionsRoot: root,
  runner: new PipelineRunner(createClaudeStages),
  loadSettings: () => loadDesktopSettings(undefined, log),
  // Buttons in the page ("Yeni akış topla") are handled by the preload.
  renderTimeline: (doc) => renderTimeline(doc, { actions: true }),
  sendToHost: (command) => sendToCollectBrowser(command),
  onStatus: broadcast,
  onAwaitingConfirmation: ({ uniquePostCount }) => {
    notify(
      `${uniquePostCount} posts collected`,
      "Build the timeline now? Click to open, then choose “Build timeline”.",
      () => void openReader(),
    );
  },
  onReady: ({ timelinePath, selected }) => {
    if (reader.timelineReady(timelinePath)) return;
    notify(
      "Your timeline is ready",
      `${selected} posts, finite by design. Click to read.`,
      () => reader.open(timelinePath),
    );
  },
  log,
});

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: `No More Clickbait — ${title}`, body });
  if (onClick) notification.on("click", onClick);
  notification.show();
}

const STAGE_LABELS: Record<RunStage, string> = {
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

function broadcast(status: DesktopStatus): void {
  for (const contents of [monitor?.webContents, reader.webContents]) {
    if (contents && !contents.isDestroyed()) contents.send("nmc:status", status);
  }
  tray?.setToolTip(`No More Clickbait — ${STAGE_LABELS[status.run.stage]}`);
  const stage = status.run.stage;
  if (stage === "error" && lastStage !== "error" && !reader.webContents) {
    notify(
      "timeline not prepared",
      status.run.error?.message ?? "The run failed.",
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

function createMonitor(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 640,
    resizable: false,
    show: false,
    title: "No More Clickbait",
    autoHideMenuBar: true,
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
    title: "No More Clickbait — Settings",
    autoHideMenuBar: true,
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
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
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
  // unresolvable choice keeps the older any-host behaviour via the
  // controller's own refusal when nobody answers.
  if (collectBrowser) {
    const ensured = await ensureCollectBrowser({
      resolution: collectBrowser,
      isConnected: (browser) =>
        link?.hosts.some((host) => hostMatchesBrowser(host.browser, browser)) ?? false,
      launch: launchDetached,
      waitForConnection: (check) => waitForConnection(check),
    });
    if (!ensured.ok) {
      log(`collection not started: ${ensured.reason}`);
      notify("collection not started", ensured.reason, showMonitor);
      return;
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Collect new timeline", click: () => void startCollection() },
      { label: "Open reading window", click: () => void openReader() },
      { label: "Show status", click: showMonitor },
      { label: "Settings…", click: showSettings },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleMonitor);
}

/** Only our own two windows may call into main, each within ipc-policy.ts. */
function callerAllowed(channel: string, event: IpcMainInvokeEvent): boolean {
  const sender = event.sender;
  const window =
    sender === monitor?.webContents || sender === settingsWindow?.webContents
      ? "monitor"
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
      error: "The browser link could not be opened (is another copy of the app running?).",
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
  await settingsManager
    .init()
    .catch((error: unknown) => log(`settings: ${String(error)}`));
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

app.on("before-quit", () => {
  controller.cancel();
  void link?.close();
});

// Tray app: closing the windows must not quit the process.
app.on("window-all-closed", () => {
  // Intentionally empty.
});
