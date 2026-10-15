import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Post, PostBatch } from "@nmc/core";

// The first session.json write fails once; everything else hits the disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  let remainingFailures = 1;
  async function writeFile(...args: Parameters<typeof actual.writeFile>): Promise<void> {
    const [path] = args;
    if (
      remainingFailures > 0 &&
      typeof path === "string" &&
      path.endsWith("session.json.tmp")
    ) {
      remainingFailures -= 1;
      throw new Error("synthetic disk failure");
    }
    await actual.writeFile(...args);
  }
  return { ...actual, writeFile };
});

import { listSessions, PostSessionStore } from "./post-session-store.js";

// Fully synthetic posts — no real feed data.
function post(id: string): Post {
  return {
    id,
    source: "x-home-timeline",
    authorHandle: "synthetic",
    text: `synthetic post ${id}`,
    url: `https://x.com/synthetic/status/${id}`,
    publishedAt: "2026-01-01T09:00:00.000Z",
    media: [],
    promoted: false,
  };
}

function batch(capturedAt: string, ids: string[]): PostBatch {
  return { source: "x-home-timeline", capturedAt, posts: ids.map(post) };
}

describe("PostSessionStore session.json retry", () => {
  let root: string;
  const clock = "2026-01-01T10:00:00.000Z";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmc-session-retry-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retries session.json after a failed write instead of losing the Mode B tag", async () => {
    const store = new PostSessionStore(root, () => clock);
    await store.markMode("B");
    await expect(store.addBatch(batch(clock, ["1"]))).rejects.toThrow(
      "synthetic disk failure",
    );
    await store.addBatch(batch(clock, ["2"]));
    const [session] = await listSessions(root);
    expect(session?.info).toMatchObject({ mode: "B" });
    expect(session?.batchCount).toBe(1);
  });
});
