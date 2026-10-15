import type { FeedBatch } from "@nmc/core";
import { describe, expect, it, vi } from "vitest";
import type { CollectDeps } from "./site-collect.js";
import { collectableRules, runSites, type SiteRunDeps } from "./site-run.js";
import type { SiteState } from "./site-store.js";
import { FEED_XML, siteRule } from "./test-fixtures.js";

const FEED = "https://news.example.invalid/world/feed.xml";
const feedRule = siteRule({ collect: { method: "rss", rssUrl: FEED } });
const slowRule = siteRule({
  id: "slow.example.invalid",
  url: "https://slow.example.invalid/",
  match: ["slow.example.invalid/*"],
  collect: { method: "rss", rssUrl: "https://slow.example.invalid/feed" },
});
const deadRule = siteRule({
  id: "dead.example.invalid",
  url: "https://dead.example.invalid/",
  match: ["dead.example.invalid/*"],
  collect: { method: "rss", rssUrl: "https://dead.example.invalid/feed" },
});
const granted: SiteState = { enabled: true, permissionGranted: true };

function runDeps(sent: FeedBatch[], saved: Record<string, SiteState>): SiteRunDeps {
  const collect: CollectDeps = {
    fetchText: (url) => {
      if (url === FEED) return Promise.resolve({ ok: true, text: FEED_XML, finalUrl: url });
      if (url.startsWith("https://slow")) return new Promise(() => undefined);
      return Promise.reject(new Error("network down"));
    },
    extractStatic: () => Promise.reject(new Error("unused")),
    takeRequestBuffer: () => Promise.resolve(null),
    collectViaPage: () => Promise.reject(new Error("unused")),
  };
  return {
    collect,
    sendBatch: (batch) => {
      sent.push(batch);
      return true;
    },
    saveState: (id, state) => {
      saved[id] = state;
      return Promise.resolve();
    },
    now: () => "2026-10-15T12:00:00.000Z",
    timeoutMs: 20,
  };
}

describe("custom sites in a collection", () => {
  it("includes only enabled sites with their permission", () => {
    const rules = [feedRule, slowRule, deadRule];
    expect(
      collectableRules(rules, {
        [feedRule.id]: granted,
        [slowRule.id]: { enabled: false, permissionGranted: true },
        [deadRule.id]: { enabled: true, permissionGranted: false },
      }).map((rule) => rule.id),
    ).toEqual([feedRule.id]);
  });

  it("collects in parallel; a slow or failing site never fails the others", async () => {
    const sent: FeedBatch[] = [];
    const saved: Record<string, SiteState> = {};
    const states = { [feedRule.id]: granted, [slowRule.id]: granted, [deadRule.id]: granted };
    const outcomes = await runSites(
      [feedRule, slowRule, deadRule],
      states,
      runDeps(sent, saved),
    );
    expect(outcomes).toEqual([
      { siteId: feedRule.id, method: "rss", status: "ok", itemCount: 3 },
      expect.objectContaining({ siteId: slowRule.id, status: "timeout", itemCount: 0 }),
      expect.objectContaining({ siteId: deadRule.id, status: "error", itemCount: 0 }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      siteId: feedRule.id,
      capturedAt: "2026-10-15T12:00:00.000Z",
    });
    expect(sent[0]?.items).toHaveLength(3);
    expect(saved[feedRule.id]).toMatchObject({ lastStatus: "ok", lastItemCount: 3 });
    expect(saved[slowRule.id]).toMatchObject({
      lastStatus: "fetch-error",
      lastMessage: "timed out",
    });
    expect(saved[deadRule.id]?.lastStatus).toBe("fetch-error");
  });

  it("reports items the closed desktop link could not take", async () => {
    const deps = runDeps([], {});
    deps.sendBatch = vi.fn(() => false);
    const [outcome] = await runSites([feedRule], { [feedRule.id]: granted }, deps);
    expect(outcome).toMatchObject({ status: "error", itemCount: 0 });
    expect(outcome?.message).toMatch(/not delivered/);
  });
});
