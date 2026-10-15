import type { CollectionProgress, CollectionStartResult } from "@nmc/core";
import type { BrowserFamily } from "./browser-identity.js";
import type { BridgeHandlers } from "./handler.js";
import type { PostSessionStore } from "./post-session-store.js";

/**
 * Relays the extension's collection answers to the desktop app, tagging
 * the session as a Mode B run. Only the run's own host session may be
 * tagged: the start-result can still arrive over the previous port (the
 * desktop retires it for the run's new host session only after answering),
 * so tagging there would mark the user's own browsing (Mode A) as Mode B
 * and leave a phantom "not completed" session behind. The first progress
 * always comes from the run's own session, so only it tags. `browser`
 * (the host's own, when known) goes into the tag.
 */
export function createCollectionRelay(
  sessionStore: PostSessionStore,
  send: (message: CollectionStartResult | CollectionProgress) => void,
  browser?: () => Promise<BrowserFamily>,
): {
  onCollectionStartResult: NonNullable<BridgeHandlers["onCollectionStartResult"]>;
  onCollectionProgress: NonNullable<BridgeHandlers["onCollectionProgress"]>;
} {
  return {
    onCollectionStartResult: (result) => {
      send(result);
    },
    onCollectionProgress: (progress) => {
      sessionStore.markMode("B", browser?.()).catch(() => undefined);
      send(progress);
    },
  };
}
