import {
  BridgeMessageSchema,
  type BridgeReply,
  type CaptureStats,
  type CollectionComplete,
  type CollectionProgress,
  type CollectionStartResult,
  type ModeBRunSummary,
  type OversizedCapture,
  type PostBatch,
  type RawCapture,
  type SyncedSettings,
} from "@nmc/core";

export interface BridgeHandlers {
  /** A ping opens the extension's long-lived port (the desktop link starts on it). */
  onPing?: () => void;
  /** Called with every validated post batch from the extension. */
  onPostBatch(batch: PostBatch): Promise<void> | void;
  /** Stores one raw developer capture; returns its sequence number. */
  onRawCapture?: (capture: RawCapture) => Promise<{ sequence: number }>;
  /** Records a refused oversized capture (counter + summary only). */
  onOversizedCapture?: (capture: OversizedCapture) => Promise<void> | void;
  /** Cumulative capture counts, reported back to the extension. */
  captureStats?: () => CaptureStats;
  /** Records a finished Mode B run's counts in the session summary. */
  onModeBRun?: (run: ModeBRunSummary) => Promise<void> | void;
  /** Closes the collection session and tells the desktop app it can run. */
  onCollectionComplete?: (complete: CollectionComplete) => Promise<void> | void;
  /** Relays the extension's answer to the desktop's start-collection. */
  onCollectionStartResult?: (result: CollectionStartResult) => Promise<void> | void;
  /** Relays a Mode B run's count so far to the desktop app. */
  onCollectionProgress?: (progress: CollectionProgress) => Promise<void> | void;
  /** Saves the user's synced pipeline settings for the desktop. */
  onSettingsSync?: (settings: SyncedSettings) => Promise<void> | void;
}

const EMPTY_STATS: CaptureStats = {
  responseCount: 0,
  postCount: 0,
  uniquePostCount: 0,
  promotedCount: 0,
  oversizedCount: 0,
};

/**
 * Validates one raw bridge message and produces the reply to send back.
 * Anything unparseable or schema-invalid becomes an error reply — the
 * peer is a browser extension, but its payload is feed-derived and
 * therefore untrusted.
 */
export async function handleBridgeMessage(
  raw: string,
  handlers: BridgeHandlers,
): Promise<BridgeReply> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { type: "error", message: "message is not valid JSON" };
  }

  const parsed = BridgeMessageSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      type: "error",
      message: `invalid bridge message: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    };
  }

  switch (parsed.data.type) {
    case "ping":
      handlers.onPing?.();
      return { type: "pong" };
    case "post-batch":
      await handlers.onPostBatch(parsed.data.batch);
      return { type: "batch-accepted", postCount: parsed.data.batch.posts.length };
    case "raw-capture": {
      if (!handlers.onRawCapture) {
        return { type: "error", message: "developer capture is not configured on this host" };
      }
      const { sequence } = await handlers.onRawCapture(parsed.data);
      return {
        type: "capture-accepted",
        sequence,
        stats: handlers.captureStats?.() ?? EMPTY_STATS,
      };
    }
    case "capture-oversized": {
      await handlers.onOversizedCapture?.(parsed.data);
      return {
        type: "capture-rejected",
        message: `oversized ${parsed.data.operation} response (${parsed.data.byteLength} bytes framed) exceeds the bridge ceiling and was not captured`,
        stats: handlers.captureStats?.() ?? EMPTY_STATS,
      };
    }
    case "mode-b-run": {
      if (!handlers.onModeBRun) {
        return {
          type: "error",
          message: "Mode B run recording is not configured on this host",
        };
      }
      await handlers.onModeBRun(parsed.data.run);
      return { type: "mode-b-run-recorded" };
    }
    case "settings-sync": {
      if (!handlers.onSettingsSync) {
        return { type: "error", message: "settings sync is not configured on this host" };
      }
      await handlers.onSettingsSync(parsed.data.settings);
      return { type: "settings-synced" };
    }
    case "collection-complete": {
      if (!handlers.onCollectionComplete) {
        return {
          type: "error",
          message: "collection sessions are not configured on this host",
        };
      }
      await handlers.onCollectionComplete(parsed.data);
      return { type: "collection-recorded" };
    }
    case "collection-start-result":
      await handlers.onCollectionStartResult?.(parsed.data);
      return { type: "collection-recorded" };
    case "collection-progress":
      await handlers.onCollectionProgress?.(parsed.data);
      return { type: "collection-recorded" };
  }
}
