import { describe, expect, it } from "vitest";
import {
  BridgeMessageSchema,
  BridgeReplySchema,
  CollectionCompleteSchema,
  FeedBatchSchema,
  type GenericItem,
} from "./schemas.js";

function item(id: string): GenericItem {
  return {
    platform: "generic",
    id,
    sourceLabel: "custom:News",
    url: `https://news.example/world/${id}`,
    domain: "news.example",
    title: `Title ${id}`,
    promoted: false,
  };
}

describe("FeedBatchSchema", () => {
  it("accepts a site batch and round-trips through the bridge", () => {
    const batch = {
      siteId: "news.example/world",
      capturedAt: "2026-10-15T12:00:00.000Z",
      items: [item("a"), item("b")],
    };
    expect(FeedBatchSchema.parse(batch)).toEqual(batch);
    expect(BridgeMessageSchema.parse({ type: "feed-batch", batch })).toEqual({
      type: "feed-batch",
      batch,
    });
    expect(
      BridgeReplySchema.parse({ type: "feed-accepted", siteId: batch.siteId, itemCount: 2 }),
    ).toEqual({ type: "feed-accepted", siteId: batch.siteId, itemCount: 2 });
  });

  it("makes the site id optional and caps the batch", () => {
    const base = { capturedAt: "2026-10-15T12:00:00.000Z", items: [item("a")] };
    expect(FeedBatchSchema.safeParse(base).success).toBe(true);
    expect(
      FeedBatchSchema.safeParse({
        ...base,
        items: Array.from({ length: 501 }, (_, i) => item(`id-${i}`)),
      }).success,
    ).toBe(false);
    expect(
      FeedBatchSchema.safeParse({ ...base, items: [{ ...item("a"), url: "ftp://x" }] }).success,
    ).toBe(false);
  });

  it("carries per-site outcomes on collection-complete", () => {
    const complete = {
      type: "collection-complete",
      uniquePostCount: 3,
      responseCount: 1,
      mode: "A",
      reason: "target-reached",
      sites: [
        { siteId: "news.example/world", status: "ok", method: "rss", itemCount: 12 },
        { siteId: "blog.example", status: "timeout", itemCount: 0, message: "no answer" },
      ],
    };
    expect(CollectionCompleteSchema.parse(complete)).toEqual(complete);
    expect(
      CollectionCompleteSchema.safeParse({
        ...complete,
        sites: [{ siteId: "a", status: "great", itemCount: 1 }],
      }).success,
    ).toBe(false);
  });
});
