import { describe, expect, it, vi } from "vitest";
import { hookPatternMatches, isReadableContentType } from "./hook-protocol.js";
import { hookTargetsFor } from "./hook-targets.js";
import {
  addToRequestBuffer,
  clearRequestBuffer,
  MAX_BUFFERED_ITEMS,
  takeRequestBuffer,
} from "./request-buffer.js";
import { hookOrigins, syncHookRegistrations, type ScriptingApi } from "./site-hooks.js";
import { genericItem, MemoryArea, siteRule } from "./test-fixtures.js";

const withRequest = siteRule({
  collect: {
    method: "auto",
    request: { match: "news.example.invalid/api/more", format: "html" },
  },
});

describe("'more' response capture", () => {
  it("matches like core's URL patterns", () => {
    expect(
      hookPatternMatches(
        "news.example.invalid/api/more",
        "https://news.example.invalid/api/more?page=2",
      ),
    ).toBe(true);
    expect(
      hookPatternMatches("news.example.invalid/api/*", "https://news.example.invalid/api/x/y"),
    ).toBe(true);
    expect(
      hookPatternMatches(
        "news.example.invalid/api/more",
        "https://evil.example.invalid/api/more",
      ),
    ).toBe(false);
    expect(hookPatternMatches("news.example.invalid/api/more", "javascript:alert(1)")).toBe(
      false,
    );
    expect(isReadableContentType("text/html; charset=utf-8")).toBe(true);
    expect(isReadableContentType("application/vnd.api+json")).toBe(true);
    expect(isReadableContentType("image/png")).toBe(false);
  });

  it("arms the hook only for enabled, permitted HTML patterns on this host", () => {
    const rules = { [withRequest.id]: withRequest };
    const ok = { [withRequest.id]: { enabled: true, permissionGranted: true } };
    expect(hookTargetsFor(rules, ok, "https://news.example.invalid/world")).toEqual([
      { siteId: withRequest.id, pattern: "news.example.invalid/api/more" },
    ]);
    expect(hookTargetsFor(rules, ok, "https://other.example.invalid/")).toEqual([]);
    expect(
      hookTargetsFor(
        rules,
        { [withRequest.id]: { enabled: false, permissionGranted: true } },
        "https://news.example.invalid/",
      ),
    ).toEqual([]);
    expect(hookTargetsFor(rules, {}, "https://news.example.invalid/")).toEqual([]);
    expect(hookTargetsFor("garbage", null, "not a url")).toEqual([]);
  });

  it("registers the scripts only where needed and unregisters when nothing is", async () => {
    const api: ScriptingApi & { registered: string[][] } = {
      registered: [],
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([{ id: "nmc-site-hook" }])),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
      registerContentScripts: vi.fn((scripts: chrome.scripting.RegisteredContentScript[]) => {
        api.registered.push(
          scripts.map((s) => `${s.id}:${s.world ?? "ISOLATED"}:${(s.matches ?? []).join(",")}`),
        );
        return Promise.resolve();
      }),
    };
    const states = { [withRequest.id]: { enabled: true, permissionGranted: true } };
    const origins = hookOrigins([withRequest, siteRule({ id: "plain" })], states);
    expect(origins).toEqual(["https://news.example.invalid/*"]);
    await syncHookRegistrations(api, origins);
    expect(api.registered).toEqual([
      [
        "nmc-site-hook:MAIN:https://news.example.invalid/*",
        "nmc-site-relay:ISOLATED:https://news.example.invalid/*",
      ],
    ]);
    expect(
      hookOrigins([withRequest], {
        [withRequest.id]: { enabled: true, permissionGranted: false },
      }),
    ).toEqual([]);
    await syncHookRegistrations(api, []);
    expect(api.unregisterContentScripts).toHaveBeenCalledTimes(2);
    expect(api.registered).toHaveLength(1);
  });

  it("buffers per site, skips repeats, keeps the newest 500 and is taken once", async () => {
    const area = new MemoryArea();
    const id = withRequest.id;
    await addToRequestBuffer(
      area,
      id,
      [genericItem("a"), genericItem("b")],
      "2026-10-15T08:00:00Z",
    );
    expect(
      await addToRequestBuffer(
        area,
        id,
        [genericItem("b"), genericItem("c")],
        "2026-10-15T09:00:00Z",
      ),
    ).toBe(3);
    const many = Array.from({ length: MAX_BUFFERED_ITEMS + 5 }, (_, i) => genericItem(`n${i}`));
    expect(await addToRequestBuffer(area, id, many, "2026-10-15T10:00:00Z")).toBe(
      MAX_BUFFERED_ITEMS,
    );
    const taken = await takeRequestBuffer(area, id);
    expect(taken?.lastAt).toBe("2026-10-15T10:00:00Z");
    expect(taken?.items).toHaveLength(MAX_BUFFERED_ITEMS);
    expect(taken?.items[0]?.id).not.toBe(genericItem("a").id);
    expect(await takeRequestBuffer(area, id)).toBeNull();
    await addToRequestBuffer(area, id, [genericItem("z")], "2026-10-15T11:00:00Z");
    await clearRequestBuffer(area, id);
    expect(await takeRequestBuffer(area, id)).toBeNull();
  });

  it("loses nothing when captures and takes overlap", async () => {
    const area = new MemoryArea();
    const at = "2026-10-15T08:00:00Z";
    // Two "more" responses landing together on one site.
    await Promise.all([
      addToRequestBuffer(area, "a", [genericItem("a1")], at),
      addToRequestBuffer(area, "a", [genericItem("a2")], at),
      addToRequestBuffer(area, "b", [genericItem("b1")], at),
    ]);
    // Two sites taken in parallel: neither brings the other's items back.
    const [a, b] = await Promise.all([
      takeRequestBuffer(area, "a"),
      takeRequestBuffer(area, "b"),
    ]);
    expect(a?.items.map((item) => item.id)).toEqual([
      genericItem("a1").id,
      genericItem("a2").id,
    ]);
    expect(b?.items).toHaveLength(1);
    expect(await takeRequestBuffer(area, "a")).toBeNull();
    expect(await takeRequestBuffer(area, "b")).toBeNull();
    // A capture right behind a take stays for the next collect.
    await addToRequestBuffer(area, "a", [genericItem("a3")], at);
    const [taken] = await Promise.all([
      takeRequestBuffer(area, "a"),
      addToRequestBuffer(area, "a", [genericItem("a4")], at),
    ]);
    expect(taken?.items.map((item) => item.id)).toEqual([genericItem("a3").id]);
    expect((await takeRequestBuffer(area, "a"))?.items.map((item) => item.id)).toEqual([
      genericItem("a4").id,
    ]);
  });
});
