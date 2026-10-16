import { promises as dns, type LookupAddress } from "node:dns";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { sniffImage, type SniffedImage } from "./image-sniff.js";

/**
 * Downloads one generic card's image for the reading window (served as
 * nmc-img:, see reader-images.ts). The URL comes from feed content, so:
 * - https only, no credentials in the URL; at most 3 redirects, each
 *   target checked again;
 * - every address the host resolves to must be public (no private,
 *   loopback, link-local, CGNAT… — SSRF): checked in the connection's
 *   own DNS lookup, so the address used is the address checked; an
 *   address literal is checked before connecting;
 * - no cookies, credentials or Referer (Node's https sends none);
 * - one deadline for the whole download, a size limit enforced while
 *   reading, the server's Content-Type a raster image type (never SVG)
 *   and the bytes' own magic agreeing; a side of ≤ 2 px is a tracking
 *   pixel, refused.
 */

export const IMAGE_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 15_000,
};

/** Why an image is not shown (logged as is: no URL, no feed content). */
export type ImageRejection =
  | "url"
  | "address"
  | "redirects"
  | "status"
  | "type"
  | "size"
  | "not-image"
  | "tiny"
  | "timeout"
  | "network";

export type FetchedImage =
  ({ ok: true; bytes: Uint8Array } & SniffedImage) | { ok: false; reason: ImageRejection };

/* ── Addresses ───────────────────────────────────────────────── */

/** IPv4 blocks that are not the public internet. */
const NOT_PUBLIC_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/**
 * IPv6: only global unicast (2000::/3) is public, which already leaves
 * out loopback, link-local, unique-local, multicast and the IPv4-mapped
 * and NAT64 forms; inside it, these special-purpose blocks are not.
 */
const NOT_PUBLIC_V6: readonly [string, number][] = [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking…)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: an IPv4 address inside
  ["3fff::", 20], // documentation
];

const notPublic = new BlockList();
for (const [net, prefix] of NOT_PUBLIC_V4) notPublic.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of NOT_PUBLIC_V6) notPublic.addSubnet(net, prefix, "ipv6");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/** An address on the public internet (false for anything else, or unparsable). */
export function isPublicAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return !notPublic.check(address, "ipv4");
    if (family === 6) {
      return globalUnicast.check(address, "ipv6") && !notPublic.check(address, "ipv6");
    }
  } catch {
    // A zone id or anything else BlockList cannot read.
  }
  return false;
}

/** Resolves a host name to all of its addresses. */
export type Resolver = (hostname: string) => Promise<readonly LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

const BLOCKED = "ENMCBLOCKEDADDRESS";

/**
 * A connection's DNS lookup that refuses the host when any of its
 * addresses is not public (a mixed answer could be raced to the private one).
 */
export function guardedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        const family = options.family === 4 || options.family === 6 ? options.family : 0;
        const addresses = family ? all.filter((a) => a.family === family) : [...all];
        const first = addresses[0];
        if (!first) {
          callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
        } else if (!addresses.every((a) => isPublicAddress(a.address))) {
          callback(Object.assign(new Error("not a public address"), { code: BLOCKED }), "", 0);
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

/* ── Transport ───────────────────────────────────────────────── */

export interface TransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection (nothing more is read). */
  close(): void;
}

/** One GET, redirects not followed; connects through `lookup`. */
export type ImageTransport = (
  url: URL,
  init: { headers: Record<string, string>; lookup: LookupFunction; signal: AbortSignal },
) => Promise<TransportResponse>;

type RequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

/** Node's https client: a fresh connection per request (`agent: false`), so every one is looked up. */
export function nodeTransport(request: RequestFn = httpsRequest): ImageTransport {
  return (url, { headers, lookup, signal }) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        { method: "GET", headers, lookup, signal, agent: false },
        (res) =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: res,
            close: () => res.destroy(),
          }),
      );
      req.on("error", reject);
      req.end();
    });
}

/* ── Download ────────────────────────────────────────────────── */

export interface FetchImageOptions {
  transport?: ImageTransport;
  resolve?: Resolver;
  userAgent?: string;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

/** What the server may say it sends; the bytes decide the type served. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class Rejected extends Error {
  constructor(readonly reason: ImageRejection) {
    super(reason);
  }
}

/** https without credentials; an address literal must be public (it is never looked up). */
function checkedUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new Rejected("url");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Rejected("url");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) && !isPublicAddress(host)) throw new Rejected("address");
  return url;
}

async function readImage(res: TransportResponse, maxBytes: number): Promise<FetchedImage> {
  if (res.status !== 200) throw new Rejected("status");
  const type = String(res.headers["content-type"] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!type || !RASTER_TYPES.has(type)) throw new Rejected("type");
  if (Number(res.headers["content-length"]) > maxBytes) throw new Rejected("size");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Rejected("size");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const image = sniffImage(bytes);
  if (!image) throw new Rejected("not-image");
  if (Math.min(image.width, image.height) <= 2) throw new Rejected("tiny");
  return { ok: true, bytes, ...image };
}

export async function fetchImage(
  raw: string,
  options: FetchImageOptions = {},
): Promise<FetchedImage> {
  const {
    transport = nodeTransport(),
    resolve = systemResolver,
    userAgent,
    maxBytes = IMAGE_LIMITS.maxBytes,
    maxRedirects = IMAGE_LIMITS.maxRedirects,
    timeoutMs = IMAGE_LIMITS.timeoutMs,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    headers: {
      accept: ACCEPT,
      "accept-encoding": "identity",
      ...(userAgent ? { "user-agent": userAgent } : {}),
    },
    lookup: guardedLookup(resolve),
    signal: controller.signal,
  };
  try {
    let url = checkedUrl(raw);
    for (let hops = 0; ; hops++) {
      const res = await transport(url, init);
      if (REDIRECTS.has(res.status)) {
        res.close();
        const location = res.headers.location;
        if (!location) throw new Rejected("status");
        if (hops >= maxRedirects) throw new Rejected("redirects");
        url = checkedUrl(location, url);
        continue;
      }
      try {
        return await readImage(res, maxBytes);
      } finally {
        res.close();
      }
    }
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, reason: error.reason };
    if (controller.signal.aborted) return { ok: false, reason: "timeout" };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reason: code === BLOCKED ? "address" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
