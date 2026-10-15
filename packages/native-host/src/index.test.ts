import { describe, expect, it } from "vitest";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";

describe("native messaging framing", () => {
  it("round-trips a message", () => {
    const decoder = new MessageDecoder();
    expect(decoder.push(encodeMessage({ type: "ping" }))).toEqual(['{"type":"ping"}']);
  });

  it("reassembles messages split across chunks", () => {
    const decoder = new MessageDecoder();
    const frame = encodeMessage({ hello: "wörld" });
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual(['{"hello":"wörld"}']);
  });

  it("splits several frames arriving in one chunk", () => {
    const decoder = new MessageDecoder();
    const both = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
    expect(decoder.push(both)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("rejects an absurd length prefix", () => {
    const decoder = new MessageDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    expect(() => decoder.push(header)).toThrow(RangeError);
  });
});

describe("handleBridgeMessage", () => {
  it("answers ping with pong", async () => {
    await expect(
      handleBridgeMessage('{"type":"ping"}', { onPostBatch: () => {} }),
    ).resolves.toEqual({
      type: "pong",
    });
  });

  it("accepts a valid batch and reports its size", async () => {
    const seen: string[] = [];
    const reply = await handleBridgeMessage(
      JSON.stringify({
        type: "post-batch",
        batch: { source: "synthetic", capturedAt: "2026-01-01T00:00:00.000Z", posts: [] },
      }),
      { onPostBatch: (batch) => void seen.push(batch.source) },
    );
    expect(reply).toEqual({ type: "batch-accepted", postCount: 0 });
    expect(seen).toEqual(["synthetic"]);
  });

  it("turns garbage into an error reply instead of throwing", async () => {
    await expect(
      handleBridgeMessage("not json", { onPostBatch: () => {} }),
    ).resolves.toMatchObject({
      type: "error",
    });
    await expect(
      handleBridgeMessage('{"type":"post-batch","batch":{"posts":"nope"}}', {
        onPostBatch: () => {},
      }),
    ).resolves.toMatchObject({ type: "error" });
  });

  it("stores a raw capture and replies with sequence + cumulative stats", async () => {
    const seen: string[] = [];
    const reply = await handleBridgeMessage(
      JSON.stringify({
        type: "raw-capture",
        operation: "HomeTimeline",
        capturedAt: "2026-01-01T00:00:00.000Z",
        bodyText: '{"synthetic":true}',
      }),
      {
        onPostBatch: () => {},
        onRawCapture: (capture) => {
          seen.push(capture.operation);
          return Promise.resolve({ sequence: 7 });
        },
        captureStats: () => ({
          responseCount: 1,
          postCount: 3,
          promotedCount: 1,
          oversizedCount: 0,
        }),
      },
    );
    expect(reply).toEqual({
      type: "capture-accepted",
      sequence: 7,
      stats: { responseCount: 1, postCount: 3, promotedCount: 1, oversizedCount: 0 },
    });
    expect(seen).toEqual(["HomeTimeline"]);
  });

  it("reports an oversized capture as rejected and counts it", async () => {
    const refused: number[] = [];
    const reply = await handleBridgeMessage(
      JSON.stringify({
        type: "capture-oversized",
        operation: "HomeTimeline",
        capturedAt: "2026-01-01T00:00:00.000Z",
        byteLength: 40_000_000,
      }),
      {
        onPostBatch: () => {},
        onOversizedCapture: (capture) => void refused.push(capture.byteLength),
        captureStats: () => ({
          responseCount: 0,
          postCount: 0,
          promotedCount: 0,
          oversizedCount: 1,
        }),
      },
    );
    expect(reply).toMatchObject({ type: "capture-rejected", stats: { oversizedCount: 1 } });
    expect(refused).toEqual([40_000_000]);
  });

  it("errors when developer capture is not configured", async () => {
    await expect(
      handleBridgeMessage(
        JSON.stringify({
          type: "raw-capture",
          operation: "HomeTimeline",
          capturedAt: "2026-01-01T00:00:00.000Z",
          bodyText: "{}",
        }),
        { onPostBatch: () => {} },
      ),
    ).resolves.toMatchObject({ type: "error" });
  });
});
