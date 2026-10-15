import { BridgeMessageSchema, type BridgeReply, type PostBatch } from "@nmc/core";

export interface BridgeHandlers {
  /** Called with every validated post batch from the extension. */
  onPostBatch(batch: PostBatch): Promise<void> | void;
}

/**
 * Validates one raw bridge message and produces the reply to send back.
 * Anything unparseable or schema-invalid becomes an error reply — the
 * peer is a browser extension, but its payload is feed-derived and
 * therefore untrusted.
 */
export async function handleBridgeMessage(
  raw: string,
  handlers: BridgeHandlers,
): Promise<BridgeReply> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { type: "error", message: "message is not valid JSON" };
  }

  const parsed = BridgeMessageSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      type: "error",
      message: `invalid bridge message: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    };
  }

  switch (parsed.data.type) {
    case "ping":
      return { type: "pong" };
    case "post-batch":
      await handlers.onPostBatch(parsed.data.batch);
      return { type: "batch-accepted", postCount: parsed.data.batch.posts.length };
  }
}
