import { feedItemKey, GenericItemSchema, type GenericItem } from "@nmc/core";
import { withKeyLock } from "./key-lock.js";
import type { RequestBuffer } from "./site-collect.js";
import type { StorageArea } from "./site-store.js";
import { requestBufferKey } from "./storage-keys.js";

/**
 * Items from a site's own "more" responses, captured while the user
 * browsed it, kept in `chrome.storage.session` until the next collect
 * takes them — once: taking empties the buffer, so an item never enters
 * two feeds. At most `MAX_BUFFERED_ITEMS` per site; the oldest go first.
 * One key per site and one step at a time per key (`withKeyLock`): two
 * captures landing together, or a take racing an add, lose nothing and
 * never bring a taken item back.
 */

export const MAX_BUFFERED_ITEMS = 500;

interface StoredBuffer {
  items?: unknown[];
  lastAt?: string;
}

async function read(area: StorageArea, key: string): Promise<StoredBuffer | undefined> {
  const stored = (await area.get([key]))[key];
  return typeof stored === "object" && stored !== null ? (stored as StoredBuffer) : undefined;
}

function validItems(raw: unknown[] | undefined): GenericItem[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const parsed = GenericItemSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Adds items (repeats by `feedItemKey` skipped); returns how many the buffer now holds. */
export function addToRequestBuffer(
  area: StorageArea,
  siteId: string,
  items: GenericItem[],
  nowIso: string,
): Promise<number> {
  const key = requestBufferKey(siteId);
  return withKeyLock(key, async () => {
    const current = validItems((await read(area, key))?.items);
    const seen = new Set(current.map(feedItemKey));
    for (const item of items) {
      const itemKey = feedItemKey(item);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      current.push(item);
    }
    const kept = current.slice(-MAX_BUFFERED_ITEMS);
    await area.set({ [key]: { items: kept, lastAt: nowIso } });
    return kept.length;
  });
}

/** Takes the site's buffered items and empties its buffer. */
export function takeRequestBuffer(
  area: StorageArea,
  siteId: string,
): Promise<RequestBuffer | null> {
  const key = requestBufferKey(siteId);
  return withKeyLock(key, async () => {
    const entry = await read(area, key);
    if (!entry) return null;
    await area.remove([key]);
    const items = validItems(entry.items);
    return entry.lastAt ? { items, lastAt: entry.lastAt } : { items };
  });
}

/** Drops a deleted rule's buffer. */
export function clearRequestBuffer(area: StorageArea, siteId: string): Promise<void> {
  const key = requestBufferKey(siteId);
  return withKeyLock(key, () => area.remove([key]));
}
