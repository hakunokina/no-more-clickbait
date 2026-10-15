import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bridgeMessageByteLength,
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
