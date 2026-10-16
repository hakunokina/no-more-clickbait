import { describe, expect, it } from "vitest";
import { SettingsSchema, type ModeBRunSummary } from "@nmc/core";
import { finishOffered, lastRunLine, lastRunRows, progressLine } from "./mode-b-view.js";

describe("the popup's per-feed progress", () => {
  const both = SettingsSchema.parse({ collectTarget: 250, collectFromInstagram: true });

  it("shows nothing before the first post", () => {
    expect(progressLine(both, undefined)).toBe("");
    expect(progressLine(both, { x: { count: 0 } })).toBe("");
  });

  it("shows every collected feed against the target, a closed one ticked", () => {
    expect(progressLine(both, { x: { count: 250, closed: "target-reached" } })).toBe(
      "Collected so far: X 250 / 250 ✓ · Instagram 0 / 250",
    );
    expect(progressLine(SettingsSchema.parse({ collectTarget: 9 }), { x: { count: 3 } })).toBe(
      "Collected so far: X 3 / 9",
    );
  });

  it("ignores a malformed record", () => {
    expect(progressLine(both, { x: { count: -1 }, instagram: "lots" })).toBe("");
  });

  it("offers Finish now once any feed counted a post, even one turned off", () => {
    expect(finishOffered(undefined, undefined)).toBe(false);
    expect(finishOffered({ x: { count: 0 } }, undefined)).toBe(false);
    expect(finishOffered({ x: { count: 3 } }, undefined)).toBe(true);
    // Developer capture keeps the collection open with both ticks off.
    const neither = SettingsSchema.parse({ collectFromX: false });
    expect(progressLine(neither, { instagram: { count: 40 } })).toBe("");
    expect(finishOffered({ instagram: { count: 40 } }, undefined)).toBe(true);
  });

  it("does not offer Finish now while a Mode B run has its own Stop", () => {
    expect(finishOffered({ x: { count: 3 } }, { uniquePostCount: 3, target: 250 })).toBe(false);
  });
});

describe("the last run over several feeds", () => {
  const run: ModeBRunSummary = {
    strategy: "minimized-window",
    counter: "extension",
    target: 250,
    startedAt: "2026-01-01T10:00:00.000Z",
    endedAt: "2026-01-01T10:01:00.000Z",
    durationMs: 30_000,
    scrollCount: 20,
    scrollMovedCount: 20,
    hiddenStepCount: 20,
    responseCount: 5,
    uniquePostCount: 80,
    stopReason: "stalled",
    source: "instagram",
    legs: [
      {
        source: "x",
        counter: "extension",
        target: 250,
        uniquePostCount: 0,
        responseCount: 0,
        scrollCount: 1,
        durationMs: 6_000,
        stopReason: "not-logged-in",
      },
      {
        source: "instagram",
        counter: "extension",
        target: 250,
        uniquePostCount: 80,
        responseCount: 5,
        scrollCount: 20,
        durationMs: 30_000,
        stopReason: "stalled",
      },
    ],
  };

  it("names each feed with its count and why it stopped", () => {
    expect(lastRunLine(run)).toBe(
      "Last run: X: 0 / 250 (not logged in to X in this browser); " +
        "Instagram: 80 / 250 (no new posts for about 20 s of scrolling).",
    );
    expect(lastRunRows(run)).toContainEqual([
      "Feeds",
      "X: 0 / 250 (not logged in to X in this browser); " +
        "Instagram: 80 / 250 (no new posts for about 20 s of scrolling)",
    ]);
  });
});
