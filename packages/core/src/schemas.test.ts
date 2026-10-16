import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BridgeMessageSchema,
  bridgeMessageByteLength,
  BridgeReplySchema,
  enabledCollectSources,
  EXTENSION_SETTING_FIELDS,
  isNewerStamp,
  MANAGED_SETTING_FIELDS,
  ManagedSettingsSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  ModeBPacingSchema,
  ModeBSurfaceSchema,
  PostBatchSchema,
  SettingsFieldsSchema,
  SettingsSchema,
  SYNCED_SETTING_FIELDS,
  SyncedSettingsSchema,
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
      modeBPacing: "normal",
      collectTarget: 9,
      collectFromX: true,
      collectFromInstagram: false,
      instagramFollowedOnly: false,
      maxClickbait: 7,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
      uiLanguage: "system",
    });
    expect(SettingsSchema.safeParse({ modeBStrategy: "headless" }).success).toBe(false);
  });

  it("moves the retired background tab to the minimized window", () => {
    expect(SettingsSchema.parse({ modeBStrategy: "background-tab" }).modeBStrategy).toBe(
      "minimized-window",
    );
    expect(SettingsSchema.parse({ modeBStrategy: "offscreen-window" }).modeBStrategy).toBe(
      "offscreen-window",
    );
  });

  it("paces Mode B at normal speed unless fast is chosen", () => {
    expect(SettingsSchema.parse({}).modeBPacing).toBe("normal");
    expect(SettingsSchema.parse({ modeBPacing: "fast" }).modeBPacing).toBe("fast");
    expect(SettingsSchema.safeParse({ modeBPacing: "warp" }).success).toBe(false);
  });

  it("defaults the pipeline settings (owner: verify from read value 4)", () => {
    expect(SettingsSchema.parse({})).toMatchObject({
      timelineSize: 50,
      maxClickbait: 7,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
    });
  });

  it("enforces the bounds the Options page shows, and describes every field", () => {
    for (const [key, field] of Object.entries(SYNCED_SETTING_FIELDS)) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(
        SettingsFieldsSchema.shape[key as keyof typeof SettingsFieldsSchema.shape].description,
      ).toBe(field.description);
      if (field.kind !== "integer") continue;
      const at = (value: number) => SettingsSchema.safeParse({ [key]: value }).success;
      expect([at(field.min), at(field.max)]).toEqual([true, true]);
      expect([at(field.min - 1), at(field.max + 1), at(field.min + 0.5)]).toEqual([
        false,
        false,
        false,
      ]);
    }
    expect(SettingsSchema.safeParse({ verifyEnabled: "yes" }).success).toBe(false);
  });

  it("seeds collectTarget from the deprecated modeBTarget only when it is missing", () => {
    expect(SettingsSchema.parse({ modeBTarget: 120 }).collectTarget).toBe(120);
    expect(SettingsSchema.parse({ modeBTarget: 120, collectTarget: 400 }).collectTarget).toBe(
      400,
    );
    expect(SettingsSchema.parse({}).collectTarget).toBe(250);
    // Without either, the deprecated developer-capture target carries over.
    expect(SettingsSchema.parse({ captureTarget: 300 }).collectTarget).toBe(300);
    expect(SettingsSchema.parse({ modeBTarget: 100, captureTarget: 300 }).collectTarget).toBe(
      100,
    );
    expect(SettingsSchema.parse({ captureTarget: 300, collectTarget: 40 }).collectTarget).toBe(
      40,
    );
    expect(SettingsSchema.safeParse({ collectTarget: 10_001 }).success).toBe(false);
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

  it("carries the pacing, rate and error fields, which older summaries lack", () => {
    const later = {
      ...run,
      stopReason: "failed-to-open",
      pacing: "fast",
      scrollsPerMinute: 41.5,
      stepsWithNewResponse: 5,
      avgResponseLatencyMs: 820,
      error: "Invalid value for bounds.",
    };
    expect(BridgeMessageSchema.parse({ type: "mode-b-run", run: later })).toEqual({
      type: "mode-b-run",
      run: later,
    });
    expect(
      BridgeMessageSchema.safeParse({ type: "mode-b-run", run: { ...run, pacing: "warp" } })
        .success,
    ).toBe(false);
  });

  it("reads summaries from the pacing trial and the retired background tab", () => {
    const parse = (extra: object) =>
      BridgeMessageSchema.parse({ type: "mode-b-run", run: { ...run, ...extra } });
    expect(parse({ pacing: "fixed" })).toMatchObject({ run: { pacing: "normal" } });
    const response = parse({ pacing: "response" });
    expect(response.type === "mode-b-run" && response.run.pacing).toBeUndefined();
    expect(parse({ strategy: "background-tab" })).toMatchObject({
      run: { strategy: "background-tab" },
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

describe("collection and settings bridge messages", () => {
  const synced = SyncedSettingsSchema.parse({});

  it("accepts collection-complete with counts only and its acknowledgement", () => {
    const message = {
      type: "collection-complete",
      sessionId: "2026-01-01T10-00-00-000Z",
      uniquePostCount: 250,
      responseCount: 14,
      mode: "B",
      reason: "target-reached",
    };
    expect(BridgeMessageSchema.parse({ ...message, text: "a post" })).toEqual(message);
    const { sessionId: _sessionId, ...withoutSession } = message;
    expect(BridgeMessageSchema.safeParse(withoutSession).success).toBe(true);
    expect(BridgeMessageSchema.safeParse({ ...message, mode: "C" }).success).toBe(false);
    expect(BridgeMessageSchema.safeParse({ ...message, reason: "x".repeat(65) }).success).toBe(
      false,
    );
    expect(BridgeReplySchema.parse({ type: "collection-recorded" }).type).toBe(
      "collection-recorded",
    );
  });

  it("collects X alone by default; the ticks pick the scrolled feeds, X first", () => {
    expect(SettingsSchema.parse({})).toMatchObject({
      collectFromX: true,
      collectFromInstagram: false,
    });
    const sources = (x: boolean, instagram: boolean) =>
      enabledCollectSources(
        SettingsSchema.parse({ collectFromX: x, collectFromInstagram: instagram }),
      );
    expect(sources(true, false)).toEqual(["x"]);
    expect(sources(false, true)).toEqual(["instagram"]);
    expect(sources(true, true)).toEqual(["x", "instagram"]);
    expect(sources(false, false)).toEqual([]);
    // Settings saved before the ticks existed keep collecting X only.
    expect(enabledCollectSources(SettingsSchema.parse({ collectTarget: 40 }))).toEqual(["x"]);
  });

  it("carries each feed's outcome on collection-complete; the top-level counts stay X's", () => {
    const message = {
      type: "collection-complete",
      mode: "B",
      reason: "stalled",
      uniquePostCount: 250,
      responseCount: 9,
      target: 250,
      sources: [
        { source: "x", uniquePostCount: 250, reason: "target-reached", target: 250 },
        { source: "instagram", uniquePostCount: 40, reason: "stalled", target: 250 },
      ],
    };
    expect(BridgeMessageSchema.parse(message)).toEqual(message);
    expect(
      BridgeMessageSchema.safeParse({
        ...message,
        sources: [{ source: "reddit", uniquePostCount: 1, reason: "stalled" }],
      }).success,
    ).toBe(false);
    const progress = {
      type: "collection-progress",
      mode: "B",
      uniquePostCount: 12,
      target: 250,
      source: "instagram",
    };
    expect(BridgeMessageSchema.parse(progress)).toEqual(progress);
    const refused = { type: "collection-start-result", outcome: "no-sources", target: 250 };
    expect(BridgeMessageSchema.parse(refused)).toEqual(refused);
    const started = {
      type: "collection-start-result",
      outcome: "started",
      target: 250,
      sources: ["x", "instagram"],
    };
    expect(BridgeMessageSchema.parse(started)).toEqual(started);
  });

  it("accepts the extension's answer to start-collection", () => {
    const message = { type: "collection-start-result", outcome: "mode-b-off", target: 250 };
    expect(BridgeMessageSchema.parse(message)).toEqual(message);
    expect(
      BridgeMessageSchema.safeParse({ type: "collection-start-result", outcome: "started" })
        .success,
    ).toBe(true);
    expect(BridgeMessageSchema.safeParse({ ...message, outcome: "maybe" }).success).toBe(false);
    expect(BridgeMessageSchema.safeParse({ ...message, target: 0 }).success).toBe(false);
  });

  it("keeps the synced set to the pipeline settings and the collection target", () => {
    expect(Object.keys(synced).sort()).toEqual(Object.keys(SYNCED_SETTING_FIELDS).sort());
    expect(synced).toEqual({
      collectTarget: 250,
      collectFromX: true,
      collectFromInstagram: false,
      instagramFollowedOnly: false,
      timelineSize: 50,
      maxClickbait: 7,
      minReadValue: 2,
      minReadForVerify: 4,
      maxVerifications: 20,
      verifyEnabled: true,
    });
  });

  it("settings-sync carries the managed settings and an optional stamp", () => {
    const managed = ManagedSettingsSchema.parse({ modeBEnabled: true, modeBPacing: "fast" });
    expect(Object.keys(managed).sort()).toEqual(Object.keys(MANAGED_SETTING_FIELDS).sort());
    const stamp = { updatedAt: "2026-10-15T10:00:00.000Z", source: "desktop" } as const;
    // Deprecated targets stay in the extension.
    expect(
      BridgeMessageSchema.parse({
        type: "settings-sync",
        settings: { ...managed, modeBTarget: 50, captureTarget: 40 },
        stamp,
      }),
    ).toEqual({ type: "settings-sync", settings: managed, stamp });
    // An older extension sends the synced set only: the rest are defaults.
    expect(BridgeMessageSchema.parse({ type: "settings-sync", settings: synced })).toEqual({
      type: "settings-sync",
      settings: ManagedSettingsSchema.parse({}),
    });
    expect(
      BridgeMessageSchema.safeParse({
        type: "settings-sync",
        settings: { ...synced, maxClickbait: 0 },
      }).success,
    ).toBe(false);
    expect(
      BridgeMessageSchema.safeParse({
        type: "settings-sync",
        settings: synced,
        stamp: { ...stamp, source: "cloud" },
      }).success,
    ).toBe(false);
    expect(BridgeReplySchema.parse({ type: "settings-synced" }).type).toBe("settings-synced");
  });

  it("accepts the desktop's settings-push and the extension's answer", () => {
    const settings = ManagedSettingsSchema.parse({ maxClickbait: 4 });
    const stamp = { updatedAt: "2026-10-15T10:00:00.000Z", source: "desktop" };
    expect(BridgeReplySchema.parse({ type: "settings-push", settings, stamp })).toEqual({
      type: "settings-push",
      settings,
      stamp,
    });
    expect(BridgeReplySchema.safeParse({ type: "settings-push", settings }).success).toBe(
      false,
    );
    const result = {
      type: "settings-push-result",
      outcome: "applied",
      settings,
      stamp,
      modeBPermissionMissing: true,
    };
    expect(BridgeMessageSchema.parse(result)).toEqual(result);
    expect(BridgeMessageSchema.safeParse({ ...result, outcome: "maybe" }).success).toBe(false);
  });

  it('accepts the desktop\'s language push (a resolved language, never "system")', () => {
    expect(BridgeReplySchema.parse({ type: "ui-lang", lang: "tr" })).toEqual({
      type: "ui-lang",
      lang: "tr",
    });
    expect(BridgeReplySchema.safeParse({ type: "ui-lang", lang: "system" }).success).toBe(
      false,
    );
    expect(BridgeReplySchema.safeParse({ type: "ui-lang", lang: "de" }).success).toBe(false);
  });

  it("accepts the desktop's start-collection and link-status pushes", () => {
    expect(BridgeReplySchema.parse({ type: "start-collection" })).toEqual({
      type: "start-collection",
    });
    expect(BridgeReplySchema.parse({ type: "start-collection", target: 300 })).toEqual({
      type: "start-collection",
      target: 300,
    });
    expect(BridgeReplySchema.safeParse({ type: "start-collection", target: 0 }).success).toBe(
      false,
    );
    expect(
      BridgeReplySchema.parse({
        type: "link-status",
        desktopConnected: true,
        extensionConnected: false,
      }),
    ).toEqual({ type: "link-status", desktopConnected: true, extensionConnected: false });
    expect(
      BridgeReplySchema.safeParse({ type: "link-status", desktopConnected: true }).success,
    ).toBe(false);
  });
});

describe("extension setting fields", () => {
  it("offer exactly the schema's choices, defaults included", () => {
    const values = (field: { options: readonly { value: string }[] }) =>
      field.options.map((option) => option.value);
    expect(values(EXTENSION_SETTING_FIELDS.modeBStrategy)).toEqual(ModeBSurfaceSchema.options);
    expect(values(EXTENSION_SETTING_FIELDS.modeBPacing)).toEqual(ModeBPacingSchema.options);
    const defaults = SettingsSchema.parse({});
    for (const [key, field] of Object.entries(EXTENSION_SETTING_FIELDS)) {
      expect(defaults[key as keyof typeof EXTENSION_SETTING_FIELDS]).toBe(field.default);
    }
  });
});

describe("settings stamps", () => {
  it("is newer only when saved strictly later", () => {
    const at = (updatedAt: string) => ({ updatedAt, source: "desktop" as const });
    expect(isNewerStamp(at("2026-10-15T10:00:01.000Z"), at("2026-10-15T10:00:00.000Z"))).toBe(
      true,
    );
    expect(isNewerStamp(at("2026-10-15T10:00:00.000Z"), at("2026-10-15T10:00:00.000Z"))).toBe(
      false,
    );
    expect(isNewerStamp(at("2026-10-15T09:00:00.000Z"), at("2026-10-15T10:00:00.000Z"))).toBe(
      false,
    );
  });
});

describe("developer capture source", () => {
  const capture = {
    type: "raw-capture",
    operation: "HomeTimeline",
    capturedAt: "2026-01-01T10:00:00.000Z",
    bodyText: "{}",
  } as const;
  const stats = {
    responseCount: 1,
    postCount: 0,
    uniquePostCount: 0,
    promotedCount: 0,
    oversizedCount: 0,
  };

  it("is optional (absent means X) and limited to known sites", () => {
    expect(BridgeMessageSchema.parse(capture)).toEqual(capture);
    expect(BridgeMessageSchema.parse({ ...capture, source: "reddit" })).toEqual({
      ...capture,
      source: "reddit",
    });
    expect(BridgeMessageSchema.safeParse({ ...capture, source: "mastodon" }).success).toBe(
      false,
    );
    expect(
      BridgeMessageSchema.parse({
        type: "capture-oversized",
        source: "reddit",
        operation: "dom-added",
        capturedAt: capture.capturedAt,
        byteLength: 1,
      }),
    ).toMatchObject({ source: "reddit" });
  });

  it("travels back on capture replies", () => {
    expect(
      BridgeReplySchema.parse({
        type: "capture-accepted",
        source: "reddit",
        sequence: 1,
        stats,
      }),
    ).toMatchObject({ source: "reddit" });
    expect(
      BridgeReplySchema.parse({ type: "capture-accepted", sequence: 1, stats }),
    ).not.toHaveProperty("source");
  });
});
