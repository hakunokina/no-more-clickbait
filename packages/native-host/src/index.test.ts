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

  it("accepts a feed batch and reports its site and size", async () => {
    const seen: string[] = [];
    const batch = {
      siteId: "news.example/world",
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          platform: "generic",
          id: "a",
          sourceLabel: "custom:news",
          url: "https://news.example/world/a",
          domain: "news.example",
          title: "synthetic",
        },
      ],
    };
    const reply = await handleBridgeMessage(JSON.stringify({ type: "feed-batch", batch }), {
      onPostBatch: () => {},
      onFeedBatch: (got) => void seen.push(got.siteId ?? ""),
    });
    expect(reply).toEqual({
      type: "feed-accepted",
      siteId: "news.example/world",
      itemCount: 1,
    });
    expect(seen).toEqual(["news.example/world"]);
    await expect(
      handleBridgeMessage(JSON.stringify({ type: "feed-batch", batch }), {
        onPostBatch: () => {},
      }),
    ).resolves.toMatchObject({ type: "error" });
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
          uniquePostCount: 2,
          promotedCount: 1,
          oversizedCount: 0,
        }),
      },
    );
    expect(reply).toEqual({
      type: "capture-accepted",
      sequence: 7,
      stats: {
        responseCount: 1,
        postCount: 3,
        uniquePostCount: 2,
        promotedCount: 1,
        oversizedCount: 0,
      },
    });
    expect(seen).toEqual(["HomeTimeline"]);
  });

  it("routes a sourced capture and replies with that source's stats", async () => {
    const asked: string[] = [];
    const reply = await handleBridgeMessage(
      JSON.stringify({
        type: "raw-capture",
        source: "reddit",
        operation: "dom-initial",
        capturedAt: "2026-01-01T00:00:00.000Z",
        bodyText: "<shreddit-post></shreddit-post>",
      }),
      {
        onPostBatch: () => {},
        onRawCapture: () => Promise.resolve({ sequence: 1 }),
        captureStats: (source) => {
          asked.push(source);
          return {
            responseCount: 1,
            postCount: 1,
            uniquePostCount: 0,
            promotedCount: 0,
            oversizedCount: 0,
          };
        },
      },
    );
    expect(reply).toMatchObject({ type: "capture-accepted", source: "reddit", sequence: 1 });
    expect(asked).toEqual(["reddit"]);
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
          uniquePostCount: 0,
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

  it("records a Mode B run, or says the host cannot", async () => {
    const message = JSON.stringify({
      type: "mode-b-run",
      run: {
        strategy: "background-tab",
        counter: "host",
        target: 50,
        startedAt: "2026-01-01T10:00:00.000Z",
        endedAt: "2026-01-01T10:00:30.000Z",
        durationMs: 30_000,
        scrollCount: 5,
        scrollMovedCount: 5,
        hiddenStepCount: 5,
        responseCount: 2,
        uniquePostCount: 50,
        stopReason: "target-reached",
      },
    });
    const runs: string[] = [];
    await expect(
      handleBridgeMessage(message, {
        onPostBatch: () => {},
        onModeBRun: (run) => void runs.push(run.strategy),
      }),
    ).resolves.toEqual({ type: "mode-b-run-recorded" });
    expect(runs).toEqual(["background-tab"]);
    await expect(
      handleBridgeMessage(message, { onPostBatch: () => {} }),
    ).resolves.toMatchObject({
      type: "error",
    });
  });

  // settings-sync: see settings-store.test.ts.
  it("records a finished collection", async () => {
    const message = {
      type: "collection-complete",
      uniquePostCount: 1,
      responseCount: 1,
      mode: "A",
      reason: "target-reached",
    };
    const seen: unknown[] = [];
    await expect(
      handleBridgeMessage(JSON.stringify(message), {
        onPostBatch: () => {},
        onCollectionComplete: (complete) => void seen.push(complete),
      }),
    ).resolves.toEqual({ type: "collection-recorded" });
    expect(seen).toEqual([message]);
    await expect(
      handleBridgeMessage(JSON.stringify(message), { onPostBatch: () => {} }),
    ).resolves.toEqual({
      type: "error",
      message: "collection sessions are not configured on this host",
    });
  });
});
