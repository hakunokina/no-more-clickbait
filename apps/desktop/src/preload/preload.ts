import { contextBridge, ipcRenderer } from "electron";
import type { LlmAvailability } from "@nmc/core/llm";

/** The entire renderer-facing API. Nothing else crosses the bridge. */
export interface DesktopApi {
  checkLlmStatus(): Promise<LlmAvailability>;
}

const api: DesktopApi = {
  checkLlmStatus: () => ipcRenderer.invoke("nmc:llm-status") as Promise<LlmAvailability>,
};

contextBridge.exposeInMainWorld("nmc", api);
