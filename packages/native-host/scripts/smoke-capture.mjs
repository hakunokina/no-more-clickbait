// Smoke test for the built native host (synthetic data only).
//
//   pnpm build
//   node packages/native-host/scripts/smoke-capture.mjs
//
// Sends framed fake messages to dist/main.js, then asserts:
//  1. a raw developer capture lands verbatim under NMC_INBOX_DIR with a
//     counts/times-only summary.json, and the reply carries the stats;
//  2. a post-batch written right before stdin closes still hits disk
//     (regression: the host used to exit on stdin "end" without waiting
//     for in-flight async handlers, losing the last batch).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hostEntry = join(import.meta.dirname, "..", "dist", "main.js");
const inbox = await mkdtemp(join(tmpdir(), "nmc-smoke-"));

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function readReplies(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const replies = [];
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for replies, got ${replies.length}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        replies.push(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
        buffer = buffer.subarray(4 + length);
        if (replies.length === expected) {
          clearTimeout(timer);
          resolve(replies);
        }
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(replies);
    });
  });
}

function assert(condition, label) {
  if (!condition) throw new Error(`smoke assertion failed: ${label}`);
}

const syntheticBody = JSON.stringify({
  data: {
    entries: [
      { entryId: "tweet-synthetic-1" },
      { entryId: "tweet-synthetic-2" },
      { entryId: "promoted-tweet-synthetic-3" },
      { entryId: "cursor-bottom-0" },
    ],
  },
});

// --- Run 1: developer capture round-trip -------------------------------
{
  const child = spawn(process.execPath, [hostEntry], {
    env: { ...process.env, NMC_INBOX_DIR: inbox },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const repliesPromise = readReplies(child, 2);
  child.stdin.write(
    frame({
      type: "raw-capture",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:00:00.000Z",
      bodyText: syntheticBody,
    }),
  );
  child.stdin.write(
    frame({
      type: "capture-oversized",
      operation: "HomeTimeline",
      capturedAt: "2026-01-01T10:01:00.000Z",
      byteLength: 40 * 1024 * 1024,
    }),
  );
  const replies = await repliesPromise;
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));

  assert(replies[0]?.type === "capture-accepted", "first reply is capture-accepted");
  assert(replies[0]?.stats?.postCount === 2, "stats count 2 posts");
  assert(replies[0]?.stats?.promotedCount === 1, "stats count 1 promoted");
  assert(replies[1]?.type === "capture-rejected", "oversized reply is capture-rejected");
  assert(replies[1]?.stats?.oversizedCount === 1, "stats count 1 oversized");

  const sessions = await readdir(inbox);
  assert(sessions.length === 1, `one session dir under inbox, got ${sessions.length}`);
  const sessionDir = join(inbox, sessions[0]);
  const files = (await readdir(sessionDir)).sort();
  assert(files.length === 2, `one dump + summary, got ${files.join(", ")}`);
  const dump = await readFile(join(sessionDir, files[0]), "utf8");
  assert(dump === syntheticBody, "dump is the raw body verbatim");
  const summary = JSON.parse(await readFile(join(sessionDir, "summary.json"), "utf8"));
  assert(summary.postCount === 2 && summary.promotedCount === 1, "summary counts");
  assert(
    summary.responseCount === 1 && summary.oversizedCount === 1,
    "summary response/oversized",
  );
  assert(summary.firstCapturedAt === "2026-01-01T10:00:00.000Z", "summary first time");
  assert(summary.lastCapturedAt === "2026-01-01T10:01:00.000Z", "summary last time");
  assert(summary.collectionSpanMs === 60_000, "summary span");
  console.log(`capture smoke OK — session dir: ${sessionDir}`);
}

// --- Run 2: last batch survives an immediate stdin close ---------------
{
  const child = spawn(process.execPath, [hostEntry], {
    env: { ...process.env, NMC_INBOX_DIR: inbox },
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Write and close immediately, without waiting for the reply: the host
  // must drain the in-flight write before exiting.
  child.stdin.end(
    frame({
      type: "post-batch",
      batch: { source: "smoke", capturedAt: "2026-01-01T10:05:00.000Z", posts: [] },
    }),
  );
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert(code === 0, `host exits 0, got ${code}`);
  const files = await readdir(inbox);
  const batches = files.filter((name) => name.startsWith("batch-"));
  assert(batches.length === 1, `one batch file written before exit, got ${batches.length}`);
  console.log(`stdin-close smoke OK — batch file: ${batches[0]}`);
}

await rm(inbox, { recursive: true, force: true });
console.log("smoke-capture: all assertions passed");
