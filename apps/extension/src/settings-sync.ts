import { BridgeReplySchema, SyncedSettingsSchema, type BridgeMessage } from "@nmc/core";

/**
 * Sends the pipeline settings to the desktop side (`settings-sync`).
 * The native host saves them where the desktop pipeline reads them.
 * Only the synced pipeline settings travel — nothing personal or
 * secret. The extension's own copy in chrome.storage stays the source
 * of truth: when the host is missing or too old, the settings are
 * still saved there and go out on the next sync.
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
): Promise<SettingsSyncResult> {
  const message: BridgeMessage = {
    type: "settings-sync",
    settings: SyncedSettingsSchema.parse(settings),
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
): (settings: unknown) => Promise<SettingsSyncResult> {
  let pending:
    { settings: unknown; waiters: ((result: SettingsSyncResult) => void)[] } | undefined;
  let draining = false;
  async function drain(): Promise<void> {
    draining = true;
    while (pending) {
      const batch = pending;
      pending = undefined;
      let result: SettingsSyncResult;
      try {
        result = await syncSettings(batch.settings, send);
      } catch (error) {
        result = { status: "rejected", detail: String(error) };
      }
      for (const resolve of batch.waiters) resolve(result);
    }
    draining = false;
  }
  return (settings) =>
    new Promise((resolve) => {
      if (pending) {
        pending.settings = settings;
        pending.waiters.push(resolve);
      } else {
        pending = { settings, waiters: [resolve] };
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
      return (
        "Could not reach the desktop app — settings are saved in the extension and will be " +
        "sent the next time the browser starts or you save again."
      );
    case "rejected":
      return (
        "The desktop app did not accept the settings (its native host may be older than the " +
        "extension: run `pnpm build` and re-register the host). Settings are saved in the extension."
      );
  }
}
