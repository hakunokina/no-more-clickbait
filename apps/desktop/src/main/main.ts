import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCliProvider, type LlmAvailability } from "@nmc/core/llm";

/**
 * Desktop shell: lives in the system tray and shows a compact
 * "token monitor" style status window. Security posture is strict:
 * sandbox on, context isolation on, node integration off, a single
 * narrow preload bridge, and no remote content ever.
 *
 * The pipeline itself (score -> verify -> render) runs here in later
 * changes; this skeleton wires the window, the tray, the LLM provider
 * health check and the secret store.
 */

const here = dirname(fileURLToPath(import.meta.url));

// Secrets (future providers) go through ./electron-secret-store.ts
// (Electron safeStorage). Phase 1 needs none: the CLI owns its auth.

let window: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    resizable: false,
    show: false,
    title: "No More Clickbait",
    webPreferences: {
      preload: join(here, "preload.cjs"),
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

  void win.loadFile(join(here, "renderer", "index.html"));
  return win;
}

function toggleWindow(): void {
  if (!window || window.isDestroyed()) window = createWindow();
  if (window.isVisible()) window.hide();
  else window.show();
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
      { label: "Show status", click: toggleWindow },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleWindow);
}

ipcMain.handle("nmc:llm-status", async (): Promise<LlmAvailability> => {
  // Only ever runs when the user asks from the status window.
  return createClaudeCliProvider().checkAvailable();
});

void app.whenReady().then(() => {
  createTray();
  window = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
});

// Tray app: closing the window must not quit the process.
app.on("window-all-closed", () => {
  // Intentionally empty.
});
