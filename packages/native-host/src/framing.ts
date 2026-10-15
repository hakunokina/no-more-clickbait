/**
 * Chrome/Brave Native Messaging framing: each message is a 4-byte
 * little-endian length prefix followed by that many bytes of UTF-8 JSON.
 * There is deliberately NO TCP/HTTP port anywhere in this bridge.
 */
import { MAX_BRIDGE_MESSAGE_BYTES } from "@nmc/core";

/** Browsers cap a single host->extension message at 1 MB; guard inputs too. */
export const MAX_MESSAGE_BYTES = MAX_BRIDGE_MESSAGE_BYTES;

export function encodeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Stateful decoder for a chunked byte stream (e.g. process.stdin). */
export class MessageDecoder {
  #buffer = Buffer.alloc(0);

  /** Feeds a chunk; returns every complete message payload it unlocks. */
  push(chunk: Buffer): string[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: string[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        throw new RangeError(
          `native message length ${length} exceeds limit ${MAX_MESSAGE_BYTES}`,
        );
      }
      if (this.#buffer.length < 4 + length) break;
      messages.push(this.#buffer.subarray(4, 4 + length).toString("utf8"));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return messages;
  }
}
