import { isReaderPage } from "../preload/reader-bridge.js";

/**
 * Which window may make which call into main. The monitor (our own
 * local page) may make all of them. The reading window may make the
 * reader page's calls only while it shows our reader.html (exact URL
 * match, the same rule its preload uses); while it shows a timeline
 * (untrusted feed content) only the page's own two buttons — collect,
 * retry — get through, sent from the preload's isolated world. The
 * Settings window (also local, no navigation) gets its own three calls.
 */

export type IpcWindow = "monitor" | "reader" | "settings";

const SETTINGS_CHANNELS: ReadonlySet<string> = new Set([
  "nmc:get-settings-status",
  "nmc:update-settings",
  "nmc:set-browser-choice",
]);

const READER_PAGE_CHANNELS: ReadonlySet<string> = new Set([
  "nmc:get-status",
  "nmc:start-collection",
  "nmc:cancel-run",
  "nmc:retry-run",
  "nmc:build-timeline",
  "nmc:open-reader",
]);

const TIMELINE_PAGE_CHANNELS: ReadonlySet<string> = new Set([
  "nmc:start-collection",
  "nmc:retry-run",
]);

export function ipcAllowed(
  channel: string,
  window: IpcWindow | null,
  frameUrl: string | null,
  readerPageUrl: string,
): boolean {
  if (window === "monitor") return true;
  if (window === "settings") return SETTINGS_CHANNELS.has(channel);
  if (window !== "reader" || frameUrl === null) return false;
  return (
    isReaderPage(frameUrl, readerPageUrl) ? READER_PAGE_CHANNELS : TIMELINE_PAGE_CHANNELS
  ).has(channel);
}
