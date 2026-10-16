import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ManagedSettings } from "@nmc/core";
import type { LlmAvailability } from "@nmc/core/llm";
import type { BrowserChoice, SettingsStatus } from "../shared/settings-status.js";
import type { DesktopStatus } from "../shared/status.js";

/**
 * The monitor window's API. Nothing else crosses the bridge: status
 * (counts only) flows in, a handful of commands flow out; main checks
 * every caller. The reading window has its own, narrower preload
 * (reader-preload.ts).
 */
export interface DesktopApi {
  checkLlmStatus(): Promise<LlmAvailability>;
  getStatus(): Promise<DesktopStatus>;
  /** Subscribes to status pushes; returns the unsubscribe function. */
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  /** Asks the browser extension to collect a new timeline. */
  startCollection(): Promise<void>;
  cancelRun(): Promise<boolean>;
  /** Re-runs the last session's pipeline without collecting again. */
  retryRun(): Promise<void>;
  /** Runs the pending (Mode A) collection the user confirms. */
  buildTimeline(): Promise<void>;
  openReader(): Promise<void>;
  getSettingsStatus(): Promise<SettingsStatus>;
  /** Subscribes to settings pushes; returns the unsubscribe function. */
  onSettingsStatus(listener: (status: SettingsStatus) => void): () => void;
  /** Saves settings changed in the Settings window (synced to the extension). */
  updateSettings(settings: ManagedSettings): Promise<void>;
  /**
   * The Settings page's save-what-waits, run when main asks before the
   * window closes; main lets the window go once it resolves.
   */
  onFlushSettings(flush: () => Promise<void>): void;
  /** Picks the browser collections run in ("default" = system default). */
  setBrowserChoice(choice: BrowserChoice): Promise<void>;
  openSettings(): Promise<void>;
}

let flushSettings: (() => Promise<void>) | null = null;
// Answered even before the page registers (nothing waits then), so a close is never held long.
ipcRenderer.on("nmc:flush-settings", () => {
  void (flushSettings?.() ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => ipcRenderer.send("nmc:settings-flushed"));
});

const api: DesktopApi = {
  checkLlmStatus: () => ipcRenderer.invoke("nmc:llm-status") as Promise<LlmAvailability>,
  getStatus: () => ipcRenderer.invoke("nmc:get-status") as Promise<DesktopStatus>,
  onStatus(listener) {
    const handler = (_event: IpcRendererEvent, status: DesktopStatus): void => listener(status);
    ipcRenderer.on("nmc:status", handler);
    return () => ipcRenderer.off("nmc:status", handler);
  },
  startCollection: () => ipcRenderer.invoke("nmc:start-collection") as Promise<void>,
  cancelRun: () => ipcRenderer.invoke("nmc:cancel-run") as Promise<boolean>,
  retryRun: () => ipcRenderer.invoke("nmc:retry-run") as Promise<void>,
  buildTimeline: () => ipcRenderer.invoke("nmc:build-timeline") as Promise<void>,
  openReader: () => ipcRenderer.invoke("nmc:open-reader") as Promise<void>,
  getSettingsStatus: () =>
    ipcRenderer.invoke("nmc:get-settings-status") as Promise<SettingsStatus>,
  onSettingsStatus(listener) {
    const handler = (_event: IpcRendererEvent, status: SettingsStatus): void =>
      listener(status);
    ipcRenderer.on("nmc:settings-status", handler);
    return () => ipcRenderer.off("nmc:settings-status", handler);
  },
  updateSettings: (settings) =>
    ipcRenderer.invoke("nmc:update-settings", settings) as Promise<void>,
  onFlushSettings(flush) {
    flushSettings = flush;
  },
  setBrowserChoice: (choice) =>
    ipcRenderer.invoke("nmc:set-browser-choice", choice) as Promise<void>,
  openSettings: () => ipcRenderer.invoke("nmc:open-settings") as Promise<void>,
};

contextBridge.exposeInMainWorld("nmc", api);
