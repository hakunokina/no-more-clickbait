/**
 * Synthetic image headers for the image tests: just enough bytes for
 * each format's signature and size (no pixel data is ever decoded).
 */

const bytes = (...parts: (number[] | string)[]): Buffer =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part),
    ),
  );

const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

export function png(width: number, height: number): Buffer {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
    be32(0),
    be32(0),
    "IEND",
  );
}

export function gif(width: number, height: number): Buffer {
  return bytes("GIF89a", le16(width), le16(height), [0x80, 0, 0], [0x3b]);
}

/** SOI, an APP0 segment, then a baseline frame header. */
export function jpeg(width: number, height: number): Buffer {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0],
    be16(16),
    "JFIF",
    [0, 1, 1, 0],
    be16(1),
    be16(1),
    [0, 0],
    [0xff, 0xc0],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9],
  );
}

const riff = (chunk: string, body: number[]): Buffer =>
  bytes("RIFF", le16(body.length + 12), [0, 0], "WEBP", chunk, le16(body.length), [0, 0], body);

export function webpLossy(width: number, height: number): Buffer {
  return riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

export function webpLossless(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", [
    0x2f,
    bits & 255,
    (bits >>> 8) & 255,
    (bits >>> 16) & 255,
    (bits >>> 24) & 255,
    0,
    0,
    0,
    0,
    0,
  ]);
}

export function webpExtended(width: number, height: number): Buffer {
  return riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

/** An `ftyp` box naming AVIF, then a bare `ispe` property box. */
export function avif(width: number, height: number): Buffer {
  return bytes(
    be32(24),
    "ftyp",
    "avif",
    be32(0),
    "mif1",
    "miaf",
    be32(20),
    "ispe",
    be32(0),
    be32(width),
    be32(height),
  );
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><script>alert(1)</script></svg>',
);
