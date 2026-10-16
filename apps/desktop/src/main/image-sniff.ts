/**
 * What an image's own bytes say it is: its type (by magic bytes, never
 * by what the server claims) and its pixel size. Only the raster types
 * the reading window shows; SVG and anything else are not images here.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

export interface SniffedImage {
  type: ImageType;
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sized(type: ImageType, width: number, height: number): SniffedImage | null {
  return width > 0 && height > 0 ? { type, width, height } : null;
}

function png(bytes: Uint8Array): SniffedImage | null {
  // Signature, then the IHDR chunk: width and height, big-endian.
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const v = view(bytes);
  return sized("image/png", v.getUint32(16), v.getUint32(20));
}

function gif(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 10) return null;
  const v = view(bytes);
  return sized("image/gif", v.getUint16(6, true), v.getUint16(8, true));
}

/** The first start-of-frame segment's size (SOF0…SOF15 but DHT, JPG and DAC). */
function jpeg(bytes: Uint8Array): SniffedImage | null {
  const v = view(bytes);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Stand-alone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = v.getUint16(at + 2);
    if (length < 2) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame) {
      if (at + 9 > bytes.length) return null;
      return sized("image/jpeg", v.getUint16(at + 7), v.getUint16(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 30) return null;
  const v = view(bytes);
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    // Lossy: the key frame's start code, then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return sized("image/webp", v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
  }
  if (chunk === "VP8L") {
    // Lossless: a signature byte, then width-1 and height-1 in 14 bits each.
    if (bytes[20] !== 0x2f) return null;
    const bits = v.getUint32(21, true);
    return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    // Extended: canvas width-1 and height-1, 24 bits each.
    const width = (bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16);
    const height = (bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16);
    return sized("image/webp", width + 1, height + 1);
  }
  return null;
}

/** An `ftyp` box naming AVIF, and the first image spatial extent (`ispe`) property. */
function avif(bytes: Uint8Array): SniffedImage | null {
  const v = view(bytes);
  const ftypSize = v.getUint32(0);
  if (ftypSize < 16 || ftypSize > bytes.length) return null;
  const brands: string[] = [ascii(bytes, 8, 4)];
  for (let at = 16; at + 4 <= ftypSize; at += 4) brands.push(ascii(bytes, at, 4));
  if (!brands.includes("avif") && !brands.includes("avis")) return null;
  const marker = [0x69, 0x73, 0x70, 0x65]; // "ispe"
  for (let at = ftypSize; at + 16 <= bytes.length; at++) {
    if (marker.every((byte, k) => bytes[at + k] === byte)) {
      // Type, version + flags, then width and height.
      return sized("image/avif", v.getUint32(at + 8), v.getUint32(at + 12));
    }
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image these bytes hold, or null when they are no image the window shows. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  if (PNG_SIGNATURE.every((byte, k) => bytes[k] === byte)) return png(bytes);
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return gif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") return avif(bytes);
  return null;
}
