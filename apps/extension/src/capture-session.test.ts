import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHomeTimeline } from "@nmc/core";
import { CaptureSession, type SessionArea } from "./capture-session.js";

// Fully synthetic HomeTimeline-shaped responses shared with core's tests.
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "core",
        "fixtures",
        "x-home-timeline",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
}

/** In-memory stand-in for chrome.storage.session (JSON round-trip like the real one). */
function fakeArea(): SessionArea & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => {
      const raw = data.get(key);
      return Promise.resolve(raw === undefined ? {} : { [key]: JSON.parse(raw) as unknown });
    },
    set: (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.stringify(value));
      return Promise.resolve();
    },
    remove: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

const response1 = parseHomeTimeline(fixture("response-1.json"));
const response2 = parseHomeTimeline(fixture("response-2.json"));

describe("CaptureSession", () => {
  it("counts distinct organic posts across two overlapping responses", async () => {
    const session = new CaptureSession(fakeArea());
    // Response 1: 4 organic + 1 ad. Response 2 repeats post 1 and
    // delivers original 7 three times (repost, itself, repost).
    await expect(session.countPosts(response1)).resolves.toBe(4);
    await expect(session.countPosts(response2)).resolves.toBe(5);
    // The old per-response sum of non-promoted posts would say 8.
    const naive = [...response1, ...response2].filter((post) => !post.promoted).length;
    expect(naive).toBe(8);
  });

  it("survives a service-worker restart via the session store", async () => {
    const area = fakeArea();
    await new CaptureSession(area).countPosts(response1);
    const restarted = new CaptureSession(area);
    await expect(restarted.countPosts(response2)).resolves.toBe(5);
  });

  it("serialises concurrent responses", async () => {
    const session = new CaptureSession(fakeArea());
    const counts = await Promise.all([
      session.countPosts(response1),
      session.countPosts(response2),
      session.countPosts(response1),
    ]);
    expect(counts).toEqual([4, 5, 5]);
  });

  it("starts from zero after reset", async () => {
    const area = fakeArea();
    const session = new CaptureSession(area);
    await session.countPosts(response1);
    await session.reset();
    expect(area.data.size).toBe(0);
    // Response 2 alone: post 1 and original 7.
    await expect(session.countPosts(response2)).resolves.toBe(2);
  });

  it("notifies once per upward crossing of the target and re-arms below it", async () => {
    const area = fakeArea();
    const session = new CaptureSession(area);
    await expect(session.reachedTarget(249, 250)).resolves.toBe(false);
    await expect(session.reachedTarget(250, 250)).resolves.toBe(true);
    await expect(session.reachedTarget(260, 250)).resolves.toBe(false);
    // Persisted: a restarted worker does not notify again.
    await expect(new CaptureSession(area).reachedTarget(270, 250)).resolves.toBe(false);
    // A new host session counts from zero again.
    await expect(session.reachedTarget(3, 250)).resolves.toBe(false);
    await expect(session.reachedTarget(251, 250)).resolves.toBe(true);
    await session.reset();
    await expect(session.reachedTarget(250, 250)).resolves.toBe(true);
  });

  it("ignores a malformed stored state", async () => {
    const area = fakeArea();
    await area.set({ "nmc-capture-session": { filter: "nope" } });
    await expect(new CaptureSession(area).countPosts(response1)).resolves.toBe(4);
  });
});
