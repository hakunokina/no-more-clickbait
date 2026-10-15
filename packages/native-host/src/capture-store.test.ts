import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionMetricsSchema } from "@nmc/core";
import { CaptureStore, defaultCaptureRoot, type CaptureSummary } from "./capture-store.js";

const SESSION_NOW = "2026-01-01T10:00:00.000Z";

// Fully synthetic HomeTimeline-shaped responses shared with core's tests.
const fixtureBody = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, "..", "..", "core", "fixtures", "x-home-timeline", name),
    "utf8",
  );

// Synthetic body only — modelled on the entryId convention, no real data.
const syntheticBody = (ids: string[]): string =>
  JSON.stringify({ data: { entries: ids.map((entryId) => ({ entryId })) } });

describe("defaultCaptureRoot", () => {
  it("prefers NMC_INBOX_DIR, then %LOCALAPPDATA%\\nmc\\captures", () => {
    expect(defaultCaptureRoot({ NMC_INBOX_DIR: "D:\\inbox", LOCALAPPDATA: "C:\\App" })).toBe(
      "D:\\inbox",
    );
    expect(defaultCaptureRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(
      join("C:\\Users\\x\\AppData\\Local", "nmc", "captures"),
    );
  });
});

describe("CaptureStore", () => {
  let root: string;
  let store: CaptureStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-capture-test-"));
    store = new CaptureStore(root, () => SESSION_NOW);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes raw bodies verbatim into a per-session dir and a counts-only summary", async () => {
    const body1 = syntheticBody(["tweet-1", "tweet-2", "promoted-tweet-3", "cursor-bottom-0"]);
    const body2 = syntheticBody(["tweet-4"]);
    await expect(
      store.store({
        type: "raw-capture",
        operation: "HomeTimeline",
        capturedAt: "2026-01-01T10:00:05.000Z",
        bodyText: body1,
      }),
    ).resolves.toBe(1);
    await expect(
      store.store({
        type: "raw-capture",
        operation: "HomeLatestTimeline",
        capturedAt: "2026-01-01T10:02:35.000Z",
        bodyText: body2,
      }),
    ).resolves.toBe(2);

    const sessionDir = store.sessionDir;
    expect(sessionDir).toBe(join(root, "2026-01-01T10-00-00-000Z"));
    const files = (await readdir(sessionDir ?? "")).sort();
    expect(files).toEqual([
      "0001-2026-01-01T10-00-05-000Z-HomeTimeline.json",
      "0002-2026-01-01T10-02-35-000Z-HomeLatestTimeline.json",
      "summary.json",
    ]);
    await expect(readFile(join(sessionDir ?? "", files[0] ?? ""), "utf8")).resolves.toBe(body1);

    const summary = JSON.parse(
      await readFile(join(sessionDir ?? "", "summary.json"), "utf8"),
    ) as CaptureSummary;
    // summary.json is a valid CollectionMetrics: numbers and times only.
    expect(CollectionMetricsSchema.parse(summary)).toMatchObject({
      firstCapturedAt: "2026-01-01T10:00:05.000Z",
      lastCapturedAt: "2026-01-01T10:02:35.000Z",
      postCount: 3,
      // entryId-only bodies carry no parseable tweets.
      uniquePostCount: 0,
      responseCount: 2,
      promotedCount: 1,
      oversizedCount: 0,
    });
    expect(summary.collectionSpanMs).toBe(150_000);
    expect(store.stats).toEqual({
      responseCount: 2,
      postCount: 3,
      uniquePostCount: 0,
      promotedCount: 1,
      oversizedCount: 0,
    });
  });

  it("counts distinct organic posts across overlapping responses", async () => {
    for (const [index, name] of ["response-1.json", "response-2.json"].entries()) {
      await store.store({
        type: "raw-capture",
        operation: "HomeTimeline",
        capturedAt: `2026-01-01T10:0${index}:00.000Z`,
        bodyText: fixtureBody(name),
      });
    }
    // Response 2 repeats post 1 and re-delivers original 7 via reposts;
    // the ad is dropped. The rough tally counts every tweet- entry.
    expect(store.stats.uniquePostCount).toBe(5);
    expect(store.stats.postCount).toBe(10);
    const summary = JSON.parse(
      await readFile(join(store.sessionDir ?? "", "summary.json"), "utf8"),
    ) as CaptureSummary;
    expect(summary.uniquePostCount).toBe(5);
  });

  it("keeps non-JSON bodies but counts no posts from them", async () => {
    await store.store({
      type: "raw-capture",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:05.000Z",
      bodyText: "not json at all",
    });
    expect(store.stats).toMatchObject({ responseCount: 1, postCount: 0 });
  });

  it("records oversized refusals in the summary without storing a body", async () => {
    await store.recordOversized({
      type: "capture-oversized",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:05.000Z",
      byteLength: 40 * 1024 * 1024,
    });
    const files = await readdir(store.sessionDir ?? "");
    expect(files).toEqual(["summary.json"]);
    expect(store.stats).toMatchObject({ responseCount: 0, oversizedCount: 1 });
    expect(store.summary()).toMatchObject({ oversizedCount: 1, collectionSpanMs: 0 });
  });
});
