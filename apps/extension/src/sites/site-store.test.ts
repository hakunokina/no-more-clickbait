import { serializeSiteRule } from "@nmc/core";
import { describe, expect, it } from "vitest";
import {
  defaultSiteState,
  deleteSiteRule,
  exportFileName,
  importSiteRule,
  loadSiteRules,
  loadSiteStates,
  migrateLegacySiteStates,
  mutateSiteState,
  putSiteState,
  recordCollect,
  removeSiteState,
  rowStatus,
  saveSiteRule,
  updateSiteState,
  type SiteState,
} from "./site-store.js";
import { MemoryArea, siteRule } from "./test-fixtures.js";

const NOW = "2026-10-15T12:00:00.000Z";
const on: SiteState = { enabled: true, permissionGranted: true };

describe("rule and state storage", () => {
  it("saves, lists by name and deletes rules; skips entries that no longer validate", async () => {
    const area = new MemoryArea();
    await saveSiteRule(
      area,
      siteRule({
        id: "b.example.invalid",
        name: "Beta",
        url: "https://b.example.invalid/",
        match: ["b.example.invalid/*"],
      }),
    );
    await saveSiteRule(area, siteRule({ name: "Alpha" }));
    (area.data["nmc.siteRules"] as Record<string, unknown>)["junk"] = { nmcRule: 1 };
    expect((await loadSiteRules(area)).map((rule) => rule.name)).toEqual(["Alpha", "Beta"]);
    await deleteSiteRule(area, "b.example.invalid");
    expect((await loadSiteRules(area)).map((rule) => rule.name)).toEqual(["Alpha"]);
  });

  it("merges state patches over the defaults", async () => {
    const area = new MemoryArea();
    await updateSiteState(area, "x", { permissionGranted: true });
    await updateSiteState(area, "x", { enabled: false });
    expect((await loadSiteStates(area))["x"]).toEqual({
      enabled: false,
      permissionGranted: true,
    });
  });

  it("keeps one key per site, so two sites finishing together keep both results", async () => {
    const area = new MemoryArea();
    await putSiteState(area, "a", on);
    await putSiteState(area, "b", on);
    await Promise.all([
      mutateSiteState(area, "a", (s) => recordCollect(s, "ok", 5, NOW)),
      mutateSiteState(area, "b", (s) => recordCollect(s, "broken", 0, NOW)),
    ]);
    const states = await loadSiteStates(area);
    expect(states["a"]).toMatchObject({ lastStatus: "ok", lastItemCount: 5 });
    expect(states["b"]).toMatchObject({ lastStatus: "broken", consecutiveZero: 1 });
    expect(Object.keys(area.data).sort()).toEqual(["nmc.siteState.a", "nmc.siteState.b"]);
  });

  it("applies same-site writes one after another on the freshest value", async () => {
    const area = new MemoryArea();
    await putSiteState(area, "a", on);
    await Promise.all([
      mutateSiteState(area, "a", (s) => recordCollect(s, "ok", 0, NOW)),
      updateSiteState(area, "a", { lastBrowseAt: NOW }),
      mutateSiteState(area, "a", (s) => recordCollect(s, "ok", 0, NOW)),
    ]);
    expect((await loadSiteStates(area))["a"]).toMatchObject({
      lastBrowseAt: NOW,
      consecutiveZero: 2,
    });
    await removeSiteState(area, "a");
    expect(await loadSiteStates(area)).toEqual({});
  });

  it("moves the old shared map to per-site keys; a newer per-site state wins", async () => {
    const area = new MemoryArea();
    area.data["nmc.siteStates"] = {
      a: { enabled: false, permissionGranted: true },
      b: { enabled: true, permissionGranted: false },
      junk: "x",
    };
    await putSiteState(area, "b", on);
    await migrateLegacySiteStates(area);
    await migrateLegacySiteStates(area);
    expect(area.data["nmc.siteStates"]).toBeUndefined();
    expect(await loadSiteStates(area)).toEqual({
      a: { enabled: false, permissionGranted: true },
      b: on,
    });
  });
});

describe("import", () => {
  const existing = [siteRule()];

  it("lists every schema problem, one readable line each", () => {
    const bad = JSON.stringify({
      nmcRule: 1,
      id: "a",
      name: "A",
      url: "ftp://a.example.invalid/",
      match: ["other.example.invalid/*"],
      collect: { method: "auto" },
      origin: "manual",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = importSiteRule(bad, existing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((line) => line.startsWith("url:"))).toBe(true);
    expect(result.errors.some((line) => line.startsWith("item:"))).toBe(true);
  });

  it("refuses broken JSON, newer formats and oversized text", () => {
    expect(importSiteRule("{ nope", existing)).toMatchObject({ ok: false });
    const newer = importSiteRule(JSON.stringify({ nmcRule: 2 }), existing);
    expect(newer.ok === false && newer.errors[0]).toMatch(/newer version/);
    const huge = importSiteRule(" ".repeat(70 * 1024), existing);
    expect(huge.ok === false && huge.errors[0]).toMatch(/limit/);
  });

  it("refuses a second rule for the same address, naming the existing one", () => {
    const same = serializeSiteRule({
      ...siteRule(),
      id: "other-id",
      url: "https://NEWS.example.invalid/world/",
    });
    expect(importSiteRule(same, existing)).toEqual({
      ok: false,
      errors: [],
      duplicateOf: "News — World",
    });
  });

  it("accepts a valid shared rule", () => {
    const shared = serializeSiteRule(
      siteRule({
        id: "forum.example.invalid/notices",
        url: "https://forum.example.invalid/notices",
        match: ["forum.example.invalid/notices"],
      }),
    );
    expect(importSiteRule(shared, existing)).toMatchObject({
      ok: true,
      rule: { id: "forum.example.invalid/notices" },
    });
  });

  it("offers a safe export file name", () => {
    expect(exportFileName({ id: "news.example.invalid/world/Top Stories" })).toBe(
      "nmc-rule-news.example.invalid-world-top-stories.json",
    );
  });
});

describe("health states", () => {
  const rule = siteRule();

  it("puts off and missing permission before any verdict", () => {
    expect(rowStatus(rule, { ...on, enabled: false, lastStatus: "broken" })).toEqual({
      kind: "off",
    });
    expect(rowStatus(rule, { ...on, permissionGranted: false })).toEqual({
      kind: "permission",
    });
    expect(rowStatus(rule, on)).toEqual({ kind: "pending" });
    expect(rowStatus(rule, { ...on, savedItemCount: 8 })).toEqual({
      kind: "new",
      savedItemCount: 8,
    });
  });

  it("goes ok → few items → broken after zero-item collects, and back", () => {
    let state = recordCollect(on, "ok", 12, NOW);
    expect(rowStatus(rule, state)).toEqual({ kind: "ok", at: NOW, items: 12 });
    state = recordCollect(state, "few-items", 2, NOW);
    expect(rowStatus(rule, state)).toMatchObject({
      kind: "few-items",
      items: 2,
      typical: 12,
      minItems: 3,
    });
    state = recordCollect(state, "broken", 0, NOW);
    state = recordCollect(state, "broken", 0, NOW);
    state = recordCollect(state, "broken", 0, NOW);
    expect(rowStatus(rule, state)).toEqual({
      kind: "broken",
      fails: 3,
      lastSuccessAt: NOW,
      lastSuccessCount: 2,
    });
    state = recordCollect(state, "ok", 10, NOW);
    expect(state.consecutiveZero).toBe(0);
    expect(rowStatus(rule, state).kind).toBe("ok");
  });

  it("keeps network failures and method notes apart from rule health", () => {
    const healthy = recordCollect(on, "ok", 12, NOW);
    const failed = recordCollect(healthy, "fetch-error", 0, NOW, { message: "HTTP 503" });
    expect(failed.consecutiveZero).toBe(0);
    expect(failed.typicalCount).toBe(12);
    expect(rowStatus(rule, failed)).toEqual({
      kind: "fetch-error",
      at: NOW,
      message: "HTTP 503",
    });
    expect(rowStatus(rule, recordCollect(healthy, "visible-tab", 0, NOW)).kind).toBe(
      "visible-tab",
    );
    expect(rowStatus(rule, recordCollect(healthy, "page-note", 0, NOW)).kind).toBe("page-note");
    expect(rowStatus(rule, recordCollect(healthy, "json-unsupported", 0, NOW)).kind).toBe(
      "json-unsupported",
    );
  });

  it("starts with collection enabled and no permission", () => {
    expect(defaultSiteState()).toEqual({ enabled: true, permissionGranted: false });
  });
});
