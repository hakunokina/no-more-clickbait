import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { MessageDecoder, encodeMessage } from "./framing.js";
import { handleBridgeMessage } from "./handler.js";

/**
 * Native Messaging host entry point. The browser launches this process
 * and speaks length-prefixed JSON over stdin/stdout. stdout is reserved
 * for protocol frames — all diagnostics go to stderr.
 *
 * Skeleton behaviour: validated post batches are dropped as JSON files
 * into the inbox directory (env NMC_INBOX_DIR, non-secret config), which
 * the desktop app will consume. Without an inbox dir batches are
 * acknowledged and discarded. Raw developer captures go through the
 * CaptureStore (see capture-store.ts): outside the repo, per-session
 * folders with a counts/times-only summary.json.
 */
const inboxDir = process.env["NMC_INBOX_DIR"];
const captureStore = new CaptureStore();

async function storeBatch(batch: unknown): Promise<void> {
  if (!inboxDir) return;
  await mkdir(inboxDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await writeFile(
    join(inboxDir, `batch-${stamp}.json`),
    JSON.stringify(batch, null, 2),
    "utf8",
  );
}

const decoder = new MessageDecoder();

/**
 * In-flight message handlers. When stdin closes the process must not
 * die before these settle — a browser that sends a batch and closes
 * the port right away would otherwise lose its last write.
 */
const pending = new Set<Promise<void>>();

function dispatch(raw: string): void {
  const task = handleBridgeMessage(raw, {
    onPostBatch: storeBatch,
    onRawCapture: async (capture) => ({ sequence: await captureStore.store(capture) }),
    onOversizedCapture: (capture) => captureStore.recordOversized(capture),
    captureStats: () => captureStore.stats,
  })
    .then((reply) => {
      process.stdout.write(encodeMessage(reply));
    })
    .catch((error: unknown) => {
      process.stderr.write(`native-host: handler error: ${String(error)}\n`);
      process.stdout.write(encodeMessage({ type: "error", message: "internal host error" }));
    })
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

process.stdin.on("data", (chunk: Buffer) => {
  let raws: string[];
  try {
    raws = decoder.push(chunk);
  } catch (error) {
    process.stderr.write(`native-host: framing error: ${String(error)}\n`);
    process.exit(1);
    return;
  }
  for (const raw of raws) dispatch(raw);
});

process.stdin.on("end", () => {
  void (async () => {
    // Drain in-flight handlers (file writes) before exiting; handlers
    // never enqueue new ones, so one settle pass is enough.
    await Promise.allSettled([...pending]);
    process.exit(0);
  })();
});
