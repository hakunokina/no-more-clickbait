import { feedItemKey, GenericItemSchema, type GenericItem } from "@nmc/core";
import type { RequestBuffer } from "./site-collect.js";
import type { StorageArea } from "./site-store.js";
import { SITE_REQUEST_BUFFER_KEY } from "./storage-keys.js";

/**
 * Items from a site's own "more" responses, captured while the user
 * browsed it, kept in `chrome.storage.session` until the next collect
 * takes them — once: taking empties the buffer, so an item never enters
 * two feeds. At most `MAX_BUFFERED_ITEMS` per site; the oldest go first.
 */

export const MAX_BUFFERED_ITEMS = 500;

type Buffers = Record<string, { items: unknown[]; lastAt?: string }>;

async function readAll(area: StorageArea): Promise<Buffers> {
  const stored = (await area.get([SITE_REQUEST_BUFFER_KEY]))[SITE_REQUEST_BUFFER_KEY];
  return typeof stored === "object" && stored !== null ? (stored as Buffers) : {};
}

function validItems(raw: unknown[] | undefined): GenericItem[] {
  return (raw ?? []).flatMap((value) => {
    const parsed = GenericItemSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Adds items (repeats by `feedItemKey` skipped); returns how many the buffer now holds. */
export async function addToRequestBuffer(
  area: StorageArea,
  siteId: string,
  items: GenericItem[],
  nowIso: string,
): Promise<number> {
  const all = await readAll(area);
  const current = validItems(all[siteId]?.items);
  const seen = new Set(current.map(feedItemKey));
  for (const item of items) {
    const key = feedItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(item);
  }
  const kept = current.slice(-MAX_BUFFERED_ITEMS);
  await area.set({
    [SITE_REQUEST_BUFFER_KEY]: { ...all, [siteId]: { items: kept, lastAt: nowIso } },
  });
  return kept.length;
}

/** Takes the site's buffered items and empties its buffer. */
export async function takeRequestBuffer(
  area: StorageArea,
  siteId: string,
): Promise<RequestBuffer | null> {
  const all = await readAll(area);
  const entry = all[siteId];
  if (!entry) return null;
  const next = { ...all };
  delete next[siteId];
  await area.set({ [SITE_REQUEST_BUFFER_KEY]: next });
  const items = validItems(entry.items);
  return entry.lastAt ? { items, lastAt: entry.lastAt } : { items };
}

/** Drops a deleted rule's buffer. */
export async function clearRequestBuffer(area: StorageArea, siteId: string): Promise<void> {
  const all = await readAll(area);
  if (!(siteId in all)) return;
  const next = { ...all };
  delete next[siteId];
  await area.set({ [SITE_REQUEST_BUFFER_KEY]: next });
}
