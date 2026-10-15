import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * acknowledged and discarded.
 */
const inboxDir = process.env["NMC_INBOX_DIR"];

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

process.stdin.on("data", (chunk: Buffer) => {
  let raws: string[];
  try {
    raws = decoder.push(chunk);
  } catch (error) {
    process.stderr.write(`native-host: framing error: ${String(error)}\n`);
    process.exit(1);
    return;
  }
  for (const raw of raws) {
    void handleBridgeMessage(raw, { onPostBatch: storeBatch })
      .then((reply) => process.stdout.write(encodeMessage(reply)))
      .catch((error: unknown) => {
        process.stderr.write(`native-host: handler error: ${String(error)}\n`);
        process.stdout.write(encodeMessage({ type: "error", message: "internal host error" }));
      });
  }
});

process.stdin.on("end", () => process.exit(0));
