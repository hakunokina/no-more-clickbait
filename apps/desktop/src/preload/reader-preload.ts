import { contextBridge, ipcRenderer } from "electron";
import { installReaderBridge } from "./reader-bridge.js";

/** The reading window's preload; see reader-bridge.ts. */
installReaderBridge({
  href: window.location.href,
  argv: process.argv,
  ipc: ipcRenderer,
  bridge: contextBridge,
  document,
});
