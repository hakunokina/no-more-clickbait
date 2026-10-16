import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP, type LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";
import {
  fetchImage,
  isPublicAddress,
  nodeTransport,
  type FetchImageOptions,
  type ImageTransport,
  type Resolver,
} from "./image-fetch.js";
import { gif, jpeg, png, SVG } from "./test-images.js";

/** No real network: DNS answers and responses by URL, like net.connect would see them. */
interface Route {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: Uint8Array[];
  /** Never answers (until the request is aborted). */
  hang?: boolean;
}

const PUBLIC = "93.184.216.34";

function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const connected: string[] = [];
  const looked: string[] = [];
  const sent: Record<string, string>[] = [];
  let closed = 0;
  const resolve: Resolver = async (host) => {
    looked.push(host);
    const addresses = dns[host];
    if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: isIP(address) }));
  };
  const transport: ImageTransport = (url, { headers, lookup, signal }) =>
    new Promise((resolveResponse, reject) => {
      const connect = () => {
        connected.push(url.href);
        sent.push(headers);
        const route = routes[url.href] ?? { status: 404 };
        if (route.hang) {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          return;
        }
        resolveResponse({
          status: route.status ?? 200,
          headers: route.headers ?? {},
          body: (async function* () {
            for (const chunk of route.body ?? []) yield chunk;
          })(),
          close: () => {
            closed++;
          },
        });
      };
      // Like net.connect: a host name is looked up first, an address literal is not.
      const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
      if (isIP(host)) connect();
      else lookup(host, { all: true }, (error) => (error ? reject(error) : connect()));
    });
  const fetch = (url: string, options: FetchImageOptions = {}) =>
    fetchImage(url, { transport, resolve, ...options });
  return {
    fetch,
    connected,
    looked,
    sent,
    get closed() {
      return closed;
    },
  };
}

const image = (body: Uint8Array, type = "image/png"): Route => ({
  headers: { "content-type": type, "content-length": String(body.byteLength) },
  body: [body],
});
const redirect = (location: string, status = 302): Route => ({
  status,
  headers: { location },
});

describe("isPublicAddress", () => {
  it("knows the public internet from everything else", () => {
    for (const address of [PUBLIC, "8.8.8.8", "1.1.1.1", "2606:4700::1111", "2a00:1450::1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "10.1.2.3",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.254",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.2.1",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "2002:a00:1::1",
      "2001::1",
      "fe80::1%eth0",
      "localhost",
      "",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("fetchImage", () => {
  it("downloads a public https image without cookies, credentials or Referer", async () => {
    const net = fakeNet(
      { "https://img.example/a.png": image(png(64, 48)) },
      { "img.example": [PUBLIC] },
    );
    const result = await net.fetch("https://img.example/a.png", { userAgent: "test-agent" });
    expect(result).toEqual({
      ok: true,
      type: "image/png",
      width: 64,
      height: 48,
      bytes: expect.any(Uint8Array),
    });
    expect(result.ok && Buffer.from(result.bytes).equals(png(64, 48))).toBe(true);
    expect(net.sent).toEqual([
      {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
        "accept-encoding": "identity",
        "user-agent": "test-agent",
      },
    ]);
    expect(net.closed).toBe(1);
  });

  it("refuses a host that resolves to a non-public address (SSRF)", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.8",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.1.1",
      "::1",
      "fd00::5",
    ]) {
      const net = fakeNet(
        { "https://img.example/a.png": image(png(8, 8)) },
        { "img.example": [address] },
      );
      expect(await net.fetch("https://img.example/a.png"), address).toEqual({
        ok: false,
        reason: "address",
      });
      expect(net.connected).toEqual([]);
    }
    // One private address among public ones is enough to refuse (the connection may pick it).
    const mixed = fakeNet(
      { "https://img.example/a.png": image(png(8, 8)) },
      { "img.example": [PUBLIC, "10.0.0.1"] },
    );
    expect(await mixed.fetch("https://img.example/a.png")).toEqual({
      ok: false,
      reason: "address",
    });
    expect(mixed.connected).toEqual([]);
  });

  it("checks an address literal itself: it is never looked up", async () => {
    for (const url of [
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://169.254.169.254/latest",
      "https://[::ffff:7f00:1]/a.png",
    ]) {
      const net = fakeNet({ [url]: image(png(8, 8)) });
      expect(await net.fetch(url), url).toEqual({ ok: false, reason: "address" });
      expect(net.connected).toEqual([]);
      expect(net.looked).toEqual([]);
    }
    const literal = fakeNet({ "https://[2606:4700::1111]/a.png": image(png(8, 8)) });
    expect((await literal.fetch("https://[2606:4700::1111]/a.png")).ok).toBe(true);
  });

  it("takes https URLs without credentials only", async () => {
    const net = fakeNet({}, { "img.example": [PUBLIC] });
    for (const url of [
      "http://img.example/a.png",
      "https://user:pw@img.example/a.png",
      "file:///C:/a.png",
      "data:image/png;base64,AA",
      "not a url",
    ]) {
      expect(await net.fetch(url), url).toEqual({ ok: false, reason: "url" });
    }
    expect(net.connected).toEqual([]);
  });

  it("follows up to 3 redirects, checking each target again", async () => {
    const dns = {
      "a.example": [PUBLIC],
      "cdn.example": [PUBLIC],
      "intranet.example": ["10.0.0.2"],
    };
    const ok = fakeNet(
      {
        "https://a.example/1": redirect("https://cdn.example/2", 301),
        "https://cdn.example/2": redirect("/3", 307),
        "https://cdn.example/3": redirect("https://a.example/4", 308),
        "https://a.example/4": image(jpeg(300, 200), "image/jpeg"),
      },
      dns,
    );
    expect(await ok.fetch("https://a.example/1")).toMatchObject({
      ok: true,
      type: "image/jpeg",
    });
    expect(ok.connected).toHaveLength(4);

    const tooMany = fakeNet(
      {
        "https://a.example/1": redirect("https://a.example/2"),
        "https://a.example/2": redirect("https://a.example/3"),
        "https://a.example/3": redirect("https://a.example/4"),
        "https://a.example/4": redirect("https://a.example/5"),
        "https://a.example/5": image(png(8, 8)),
      },
      dns,
    );
    expect(await tooMany.fetch("https://a.example/1")).toEqual({
      ok: false,
      reason: "redirects",
    });
    expect(tooMany.connected).toHaveLength(4);

    const toPrivate = fakeNet(
      {
        "https://a.example/1": redirect("https://intranet.example/admin.png"),
        "https://intranet.example/admin.png": image(png(8, 8)),
      },
      dns,
    );
    expect(await toPrivate.fetch("https://a.example/1")).toEqual({
      ok: false,
      reason: "address",
    });
    expect(toPrivate.connected).toEqual(["https://a.example/1"]);

    const toLoopback = fakeNet(
      { "https://a.example/1": redirect("https://127.0.0.1:8080/a.png") },
      dns,
    );
    expect(await toLoopback.fetch("https://a.example/1")).toEqual({
      ok: false,
      reason: "address",
    });
    expect(toLoopback.connected).toEqual(["https://a.example/1"]);

    const toHttp = fakeNet({ "https://a.example/1": redirect("http://a.example/1.png") }, dns);
    expect(await toHttp.fetch("https://a.example/1")).toEqual({ ok: false, reason: "url" });
  });

  it("refuses other statuses", async () => {
    const net = fakeNet(
      {
        "https://a.example/gone": { status: 404 },
        "https://a.example/nowhere": { status: 302 },
      },
      { "a.example": [PUBLIC] },
    );
    expect(await net.fetch("https://a.example/gone")).toEqual({ ok: false, reason: "status" });
    expect(await net.fetch("https://a.example/nowhere")).toEqual({
      ok: false,
      reason: "status",
    });
  });

  it("refuses SVG and every non-raster type, and bytes that are no image", async () => {
    const dns = { "a.example": [PUBLIC] };
    const net = fakeNet(
      {
        "https://a.example/svg": image(SVG, "image/svg+xml"),
        "https://a.example/html": image(
          Buffer.from("<html></html>"),
          "text/html; charset=utf-8",
        ),
        "https://a.example/untyped": { body: [png(8, 8)] },
        "https://a.example/svg-as-png": image(SVG, "image/png"),
        "https://a.example/png-as-jpeg": image(png(8, 8), "image/jpeg"),
      },
      dns,
    );
    expect(await net.fetch("https://a.example/svg")).toEqual({ ok: false, reason: "type" });
    expect(await net.fetch("https://a.example/html")).toEqual({ ok: false, reason: "type" });
    expect(await net.fetch("https://a.example/untyped")).toEqual({ ok: false, reason: "type" });
    expect(await net.fetch("https://a.example/svg-as-png")).toEqual({
      ok: false,
      reason: "not-image",
    });
    // The bytes decide what is served.
    expect(await net.fetch("https://a.example/png-as-jpeg")).toMatchObject({
      ok: true,
      type: "image/png",
    });
  });

  it("stops at the size limit, declared or while reading", async () => {
    const dns = { "a.example": [PUBLIC] };
    const big = png(100, 100);
    const net = fakeNet(
      {
        "https://a.example/declared": {
          headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) },
          body: [big],
        },
        "https://a.example/streamed": {
          headers: { "content-type": "image/png" },
          body: [big, Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)],
        },
      },
      dns,
    );
    expect(await net.fetch("https://a.example/declared")).toEqual({
      ok: false,
      reason: "size",
    });
    expect(await net.fetch("https://a.example/streamed", { maxBytes: 1000 })).toEqual({
      ok: false,
      reason: "size",
    });
    expect(net.closed).toBe(2);
    expect(await net.fetch("https://a.example/streamed", { maxBytes: 4000 })).toMatchObject({
      ok: true,
    });
  });

  it("refuses tracking pixels: a side of 2 px or less", async () => {
    const net = fakeNet(
      {
        "https://a.example/1x1.gif": image(gif(1, 1), "image/gif"),
        "https://a.example/2x2.png": image(png(2, 2)),
        "https://a.example/line.png": image(png(1, 600)),
        "https://a.example/3x3.png": image(png(3, 3)),
      },
      { "a.example": [PUBLIC] },
    );
    expect(await net.fetch("https://a.example/1x1.gif")).toEqual({ ok: false, reason: "tiny" });
    expect(await net.fetch("https://a.example/2x2.png")).toEqual({ ok: false, reason: "tiny" });
    expect(await net.fetch("https://a.example/line.png")).toEqual({
      ok: false,
      reason: "tiny",
    });
    expect(await net.fetch("https://a.example/3x3.png")).toMatchObject({ ok: true, width: 3 });
  });

  it("gives up at the deadline, and on network errors", async () => {
    const net = fakeNet(
      { "https://a.example/slow": { hang: true } },
      { "a.example": [PUBLIC] },
    );
    expect(await net.fetch("https://a.example/slow", { timeoutMs: 20 })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await net.fetch("https://unknown.example/a.png")).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("puts the guard on Node's own connection lookup", async () => {
    // Node's https client resolves "localhost" through the guarded lookup: refused before connecting.
    expect(await fetchImage("https://localhost:9/a.png", { timeoutMs: 5000 })).toEqual({
      ok: false,
      reason: "address",
    });
  });
});

describe("nodeTransport", () => {
  it("sends only the given headers and streams the body", async () => {
    let seen: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png(8, 8));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // The guard is fetchImage's; this lookup only maps the test host to the local server.
      const lookup: LookupFunction = (_host, options, callback) =>
        options.all
          ? callback(null, [{ address: "127.0.0.1", family: 4 }])
          : callback(null, "127.0.0.1", 4);
      const res = await nodeTransport(httpRequest)(new URL(`http://img.test:${port}/a.png`), {
        headers: { accept: "image/png", "accept-encoding": "identity" },
        lookup,
        signal: new AbortController().signal,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.body) chunks.push(chunk);
      res.close();
      expect(res.status).toBe(200);
      expect(Buffer.concat(chunks).equals(png(8, 8))).toBe(true);
      expect(seen.cookie).toBeUndefined();
      expect(seen.referer).toBeUndefined();
      expect(seen.authorization).toBeUndefined();
      expect(seen.accept).toBe("image/png");
      expect(seen.host).toBe(`img.test:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
