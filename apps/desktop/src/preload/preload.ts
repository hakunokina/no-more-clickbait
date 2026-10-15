import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { LlmAvailability } from "@nmc/core/llm";
import type { DesktopStatus } from "../shared/status.js";

/**
 * The entire renderer-facing API, shared by the monitor and the reading
 * window. Nothing else crosses the bridge: status (counts only) flows
 * in, a handful of commands flow out; main checks every caller.
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
  openReader(): Promise<void>;
}

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
  openReader: () => ipcRenderer.invoke("nmc:open-reader") as Promise<void>,
};

contextBridge.exposeInMainWorld("nmc", api);
