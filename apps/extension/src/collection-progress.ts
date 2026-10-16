import type { CollectSource } from "@nmc/core";

/**
 * chrome.storage.session: each scrolled feed's count in the current
 * collection, as the badge shows it (the host's for X while developer
 * capture is on), and why its part ended once it did. The worker writes
 * it; the popup shows it. Cleared with every new counting session.
 */
export const COLLECTION_PROGRESS_KEY = "nmc-collection-progress";

export interface SourceProgress {
  count: number;
  /** Why this feed's part ended (absent: still collecting). */
  closed?: string;
}

export type CollectionProgressRecord = Partial<Record<CollectSource, SourceProgress>>;

function isProgress(value: unknown): value is SourceProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["count"] === "number" &&
    Number.isInteger(v["count"]) &&
    v["count"] >= 0 &&
    (v["closed"] === undefined || typeof v["closed"] === "string")
  );
}

/** The stored record, keeping only well-formed entries. */
export function readProgress(value: unknown): CollectionProgressRecord {
  if (typeof value !== "object" || value === null) return {};
  const record: CollectionProgressRecord = {};
  for (const source of ["x", "instagram"] as const) {
    const entry = (value as Record<string, unknown>)[source];
    if (isProgress(entry)) record[source] = entry;
  }
  return record;
}
