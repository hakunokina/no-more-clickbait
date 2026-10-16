import {
  BridgeReplySchema,
  isNewerStamp,
  ManagedSettingsSchema,
  SyncedSettingsSchema,
  type BridgeMessage,
  type ManagedSettings,
  type Settings,
  type SettingsPushResult,
  type SettingsStamp,
} from "@nmc/core";
import { t } from "./i18n.js";
import { applyPipelineSettings } from "./pipeline-form.js";

/**
 * Sends the settings the desktop app manages to the desktop side
 * (`settings-sync`), with the stamp of their last save. The native
 * host saves them where the desktop reads them, unless it already holds
 * a later save. Only the managed settings travel — nothing personal or
 * secret. The extension's own copy in chrome.storage stays the source
 * of truth: when the host is missing or too old, the settings are
 * still saved there and go out on the next sync.
 *
 * The desktop app can change them too (`settings-push`, see
 * applySettingsPush): the later save wins on both sides.
 */

export type SettingsSyncResult =
  | { status: "synced" }
  /** No host registered, or it could not be started. */
  | { status: "unreachable"; detail: string }
  /** The host answered but did not save (e.g. built from older sources). */
  | { status: "rejected"; detail: string };

/** One request/response exchange with the native host. */
export type SendNative = (message: BridgeMessage) => Promise<unknown>;

export const NATIVE_HOST_NAME = "io.github.hakunokina.no_more_clickbait";

/**
 * One-shot exchange: the browser starts a host process for this message
 * and rejects when no host is registered or it fails to start.
 */
export const sendNativeOnce: SendNative = (message) =>
  chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);

export async function syncSettings(
  settings: unknown,
  send: SendNative,
  stamp?: SettingsStamp,
): Promise<SettingsSyncResult> {
  const message: BridgeMessage = {
    type: "settings-sync",
    settings: ManagedSettingsSchema.parse(settings),
    ...(stamp ? { stamp } : {}),
  };
  let raw: unknown;
  try {
    raw = await send(message);
  } catch (error) {
    return { status: "unreachable", detail: String(error) };
  }
  const reply = BridgeReplySchema.safeParse(raw);
  if (!reply.success) return { status: "rejected", detail: "unexpected host reply" };
  if (reply.data.type === "settings-synced") return { status: "synced" };
  return {
    status: "rejected",
    detail: reply.data.type === "error" ? reply.data.message : `unexpected ${reply.data.type}`,
  };
}

/**
 * Serialises syncs: one host exchange at a time, so two quick Saves
 * cannot race (two host processes, renames landing out of order). Saves
 * made while one is in flight collapse into a single follow-up carrying
 * the latest settings; their promises resolve with that sync's result.
 */
export function createSettingsSyncer(
  send: SendNative,
): (settings: unknown, stamp?: SettingsStamp) => Promise<SettingsSyncResult> {
  let pending:
    | {
        settings: unknown;
        stamp: SettingsStamp | undefined;
        waiters: ((result: SettingsSyncResult) => void)[];
      }
    | undefined;
  let draining = false;
  async function drain(): Promise<void> {
    draining = true;
    while (pending) {
      const batch = pending;
      pending = undefined;
      let result: SettingsSyncResult;
      try {
        result = await syncSettings(batch.settings, send, batch.stamp);
      } catch (error) {
        result = { status: "rejected", detail: String(error) };
      }
      for (const resolve of batch.waiters) resolve(result);
    }
    draining = false;
  }
  return (settings, stamp) =>
    new Promise((resolve) => {
      if (pending) {
        pending.settings = settings;
        pending.stamp = stamp;
        pending.waiters.push(resolve);
      } else {
        pending = { settings, stamp, waiters: [resolve] };
      }
      if (!draining) void drain();
    });
}

/** Short Options-page notice for a sync result; empty when synced. */
export function describeSyncResult(result: SettingsSyncResult): string {
  switch (result.status) {
    case "synced":
      return "";
    case "unreachable":
      return t("syncUnreachable");
    case "rejected":
      return t("syncRejected");
  }
}

export interface SettingsPushDeps {
  load(): Promise<{ settings: Settings; stamp: SettingsStamp }>;
  save(settings: Settings, stamp: SettingsStamp): Promise<void>;
  /** Mode B's optional permission is granted (only a user gesture here can grant it). */
  modeBPermitted(): Promise<boolean>;
}

/**
 * Applies settings the desktop app pushed, unless the extension saved
 * later (last writer wins), and returns the answer for the host: the
 * settings the extension now holds. Mode B is never turned on without
 * its permission — the desktop cannot ask for it, so it stays off and
 * the answer says why.
 */
export async function applySettingsPush(
  push: { settings: ManagedSettings; stamp: SettingsStamp },
  deps: SettingsPushDeps,
): Promise<SettingsPushResult> {
  const current = await deps.load();
  if (isNewerStamp(current.stamp, push.stamp)) {
    return {
      type: "settings-push-result",
      outcome: "kept-newer",
      settings: ManagedSettingsSchema.parse(current.settings),
      stamp: current.stamp,
    };
  }
  const wanted = ManagedSettingsSchema.parse(push.settings);
  const permissionMissing =
    wanted.modeBEnabled && !current.settings.modeBEnabled && !(await deps.modeBPermitted());
  const next = applyPipelineSettings(
    {
      ...current.settings,
      modeBEnabled: permissionMissing ? false : wanted.modeBEnabled,
      modeBStrategy: wanted.modeBStrategy,
      modeBPacing: wanted.modeBPacing,
      devCaptureEnabled: wanted.devCaptureEnabled,
      uiLanguage: wanted.uiLanguage,
    },
    SyncedSettingsSchema.parse(wanted),
  );
  await deps.save(next, push.stamp);
  return {
    type: "settings-push-result",
    outcome: "applied",
    settings: ManagedSettingsSchema.parse(next),
    stamp: push.stamp,
    ...(permissionMissing ? { modeBPermissionMissing: true } : {}),
  };
}
