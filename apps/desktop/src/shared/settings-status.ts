import type { ManagedSettings, SettingsStamp } from "@nmc/core";
import type { BrowserFamily } from "@nmc/native-host";

/**
 * The Settings window's state: the managed settings as both sides last
 * agreed on them, whether a desktop change still waits for the browser,
 * and the "Browser for collecting" choice with what this PC offers.
 * Pushed on its own channel (the run status belongs to the controller).
 */

/** "default" = the system default browser; otherwise one family. */
export type BrowserChoice = "default" | BrowserFamily;

export interface BrowserOption {
  family: BrowserFamily;
  label: string;
  /** This is the machine's default browser. */
  systemDefault: boolean;
}

export interface SettingsStatus {
  settings: ManagedSettings;
  stamp: SettingsStamp;
  /** A desktop change the extension has not confirmed yet. */
  pending: boolean;
  /** The collecting browser's extension is linked. */
  browserConnected: boolean;
  /** Mode B was asked for here but its browser permission is missing. */
  modeBPermissionMissing: boolean;
  choice: BrowserChoice;
  /** Installed Chromium browsers the user can pick from. */
  browsers: BrowserOption[];
  /** Where collections will go, once resolved (null = not resolvable). */
  collectBrowserLabel: string | null;
  /** Why no collecting browser resolved, when there is a reason to show. */
  collectBrowserProblem: string | null;
}
