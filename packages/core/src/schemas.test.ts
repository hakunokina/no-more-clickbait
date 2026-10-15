import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BridgeMessageSchema,
  bridgeMessageByteLength,
  BridgeReplySchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  PostBatchSchema,
  SettingsSchema,
} from "./schemas.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("synthetic fixture", () => {
  it("parses as a PostBatch and contains no real-user data", () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(here, "..", "fixtures", "synthetic-batch.json"), "utf8"),
    );
    const batch = PostBatchSchema.parse(raw);
    expect(batch.posts).toHaveLength(4);
    for (const post of batch.posts) {
      expect(post.url).toContain("example.invalid");
    }
  });
});

describe("SettingsSchema", () => {
  it("defaults Mode B to OFF", () => {
    expect(SettingsSchema.parse({}).modeBEnabled).toBe(false);
  });

  it("fills the Mode B run settings into settings saved before they existed", () => {
    const old = {
      modeBEnabled: true,
      timelineSize: 30,
      devCaptureEnabled: false,
      captureTarget: 9,
    };
    expect(SettingsSchema.parse(old)).toEqual({
      ...old,
      modeBTarget: 100,
      modeBStrategy: "minimized-window",
    });
    expect(SettingsSchema.safeParse({ modeBStrategy: "headless" }).success).toBe(false);
  });

  it("defaults developer capture to OFF with a 250-post target", () => {
    const settings = SettingsSchema.parse({});
    expect(settings.devCaptureEnabled).toBe(false);
    expect(settings.captureTarget).toBe(250);
  });
});

describe("bridgeMessageByteLength", () => {
  it("measures the framed JSON in UTF-8 bytes", () => {
    expect(bridgeMessageByteLength({ type: "ping" })).toBe('{"type":"ping"}'.length);
    expect(bridgeMessageByteLength({ bodyText: "wörld" })).toBeGreaterThan(
      '{"bodyText":"wörld"}'.length,
    );
    expect(MAX_BRIDGE_MESSAGE_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("Mode B run bridge message", () => {
  const run = {
    strategy: "offscreen-window",
    counter: "host",
    target: 100,
    startedAt: "2026-01-01T10:00:00.000Z",
    endedAt: "2026-01-01T10:02:00.000Z",
    durationMs: 120_000,
    scrollCount: 30,
    scrollMovedCount: 28,
    hiddenStepCount: 0,
    responseCount: 6,
    uniquePostCount: 100,
    stopReason: "target-reached",
  };

  it("accepts a run summary and its acknowledgement", () => {
    expect(BridgeMessageSchema.parse({ type: "mode-b-run", run })).toEqual({
      type: "mode-b-run",
      run,
    });
    expect(BridgeReplySchema.parse({ type: "mode-b-run-recorded" })).toEqual({
      type: "mode-b-run-recorded",
    });
  });

  it("rejects unknown stop reasons and strips fields beyond the counts", () => {
    expect(
      BridgeMessageSchema.safeParse({
        type: "mode-b-run",
        run: { ...run, stopReason: "bored" },
      }).success,
    ).toBe(false);
    const parsed = BridgeMessageSchema.parse({
      type: "mode-b-run",
      run: { ...run, text: "a post" },
    });
    expect(parsed).not.toHaveProperty("run.text");
  });

  it("still accepts every earlier message shape", () => {
    expect(BridgeMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
    expect(
      BridgeMessageSchema.parse({
        type: "capture-oversized",
        operation: "HomeTimeline",
        capturedAt: "2026-01-01T10:00:00.000Z",
        byteLength: 1,
      }).type,
    ).toBe("capture-oversized");
  });
});
