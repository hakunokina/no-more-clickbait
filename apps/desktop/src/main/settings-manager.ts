import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isNewerStamp,
  ManagedSettingsSchema,
  SettingsStampSchema,
  UNSTAMPED,
  type ManagedSettings,
  type SettingsStamp,
} from "@nmc/core";
import { loadSettings } from "@nmc/core/settings-file";
import { desktopDataDir, type SettingsStateEvent } from "@nmc/native-host";
import { settingsFilePath } from "./settings-file.js";

/**
 * The desktop side of the two-way settings sync. The extension owns the
 * settings (chrome.storage); settings.json is the host-written mirror
 * this app reads. A change made here gets a fresh stamp and is pushed
 * through the link; until the extension confirms it, the change also
 * sits in `desktop-pending-settings.json` (this app's own file), so a
 * change made while no browser is connected survives a restart and is
 * sent as soon as a host links up or the extension reports its state.
 * Last writer wins everywhere (stamp order); this manager only ever
 * decides, sending itself is injected.
 */

export function pendingSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(desktopDataDir(env), "desktop-pending-settings.json");
}

export interface DesktopSettingsState {
  settings: ManagedSettings;
  stamp: SettingsStamp;
  /** A desktop change the extension has not confirmed yet. */
  pending: boolean;
  /** The extension is linked and can receive a push right now. */
  browserConnected: boolean;
  /** Mode B asked for from here, but its browser permission is missing. */
  modeBPermissionMissing: boolean;
}

export interface SettingsManagerDeps {
  settingsPath?: string;
  pendingPath?: string;
  /** Sends a settings-push to (the chosen browser's) host; false = nobody home. */
  sendPush(settings: ManagedSettings, stamp: SettingsStamp): boolean;
  now?: () => string;
  onState?(state: DesktopSettingsState): void;
}

interface StampedSettings {
  settings: ManagedSettings;
  stamp: SettingsStamp;
}

function parseStamped(raw: unknown): StampedSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const settings = ManagedSettingsSchema.safeParse(record["settings"]);
  const stamp = SettingsStampSchema.safeParse(record["stamp"]);
  return settings.success && stamp.success
    ? { settings: settings.data, stamp: stamp.data }
    : null;
}

export class SettingsManager {
  readonly #deps: SettingsManagerDeps;
  #current: StampedSettings = {
    settings: ManagedSettingsSchema.parse({}),
    stamp: UNSTAMPED,
  };
  #pending: StampedSettings | null = null;
  #browserConnected = false;
  #modeBPermissionMissing = false;

  constructor(deps: SettingsManagerDeps) {
    this.#deps = deps;
  }

  get state(): DesktopSettingsState {
    return {
      settings: this.#current.settings,
      stamp: this.#current.stamp,
      pending: this.#pending !== null,
      browserConnected: this.#browserConnected,
      modeBPermissionMissing: this.#modeBPermissionMissing,
    };
  }

  #settingsPath(): string {
    return this.#deps.settingsPath ?? settingsFilePath();
  }

  #pendingPath(): string {
    return this.#deps.pendingPath ?? pendingSettingsPath();
  }

  #emit(): void {
    this.#deps.onState?.(this.state);
  }

  /** Reads settings.json and a leftover pending change; the later save leads. */
  async init(): Promise<void> {
    const loaded = await loadSettings(this.#settingsPath());
    this.#current = {
      settings: ManagedSettingsSchema.parse(loaded.settings),
      stamp: loaded.stamp ?? UNSTAMPED,
    };
    this.#pending = await this.#readPending();
    if (this.#pending) {
      if (isNewerStamp(this.#pending.stamp, this.#current.stamp)) {
        this.#current = this.#pending;
      } else {
        // The file already moved past it (it was applied, or the
        // extension saved later): the pending change is spent.
        this.#pending = null;
        await this.#clearPending();
      }
    }
    this.#emit();
  }

  /** Records a change from the desktop Settings UI and tries to deliver it. */
  async change(settings: ManagedSettings): Promise<void> {
    const next: StampedSettings = {
      settings: ManagedSettingsSchema.parse(settings),
      stamp: { updatedAt: this.#deps.now?.() ?? new Date().toISOString(), source: "desktop" },
    };
    this.#current = next;
    this.#pending = next;
    this.#modeBPermissionMissing = false;
    await this.#writePending(next);
    this.#trySendPending();
    this.#emit();
  }

  /** A host linked up or went away; a fresh link retries the pending change. */
  setBrowserConnected(connected: boolean): void {
    const cameUp = connected && !this.#browserConnected;
    this.#browserConnected = connected;
    if (cameUp) this.#trySendPending();
    this.#emit();
  }

  /** The host relayed the extension's settings (its report, or its push answer). */
  async handleSettingsState(event: SettingsStateEvent): Promise<void> {
    const incoming: StampedSettings = { settings: event.settings, stamp: event.stamp };
    if (event.origin === "push-result") {
      // An answer to an older push while a later change is still
      // pending: that change stays (and goes out again, in case its own
      // push was lost); the UI does not flicker back.
      if (this.#pending && isNewerStamp(this.#pending.stamp, incoming.stamp)) {
        this.#trySendPending();
        this.#emit();
        return;
      }
      // Our push was answered either way: applied, or the extension's
      // own later save stands. Nothing is left pending.
      this.#current = incoming;
      this.#pending = null;
      this.#modeBPermissionMissing = event.modeBPermissionMissing === true;
      await this.#clearPending();
      this.#emit();
      return;
    }
    // A plain report: a still-later pending change goes out now that
    // someone is listening; anything newer from the extension wins.
    if (this.#pending && isNewerStamp(this.#pending.stamp, incoming.stamp)) {
      this.#trySendPending();
      this.#emit();
      return;
    }
    if (isNewerStamp(incoming.stamp, this.#current.stamp) || this.#pending) {
      this.#current = incoming;
      this.#pending = null;
      this.#modeBPermissionMissing = false;
      await this.#clearPending();
    }
    this.#emit();
  }

  #trySendPending(): void {
    if (!this.#pending || !this.#browserConnected) return;
    this.#deps.sendPush(this.#pending.settings, this.#pending.stamp);
  }

  async #readPending(): Promise<StampedSettings | null> {
    try {
      return parseStamped(JSON.parse(await readFile(this.#pendingPath(), "utf8")));
    } catch {
      return null;
    }
  }

  async #writePending(pending: StampedSettings): Promise<void> {
    const path = this.#pendingPath();
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async #clearPending(): Promise<void> {
    await rm(this.#pendingPath(), { force: true });
  }
}
