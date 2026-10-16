import { describe, expect, it } from "vitest";
import { sniffImage } from "./image-sniff.js";
import {
  avif,
  gif,
  jpeg,
  png,
  SVG,
  webpExtended,
  webpLossless,
  webpLossy,
} from "./test-images.js";

describe("sniffImage", () => {
  it("reads each shown format's type and size from its own bytes", () => {
    expect(sniffImage(png(640, 360))).toEqual({ type: "image/png", width: 640, height: 360 });
    expect(sniffImage(gif(320, 200))).toEqual({ type: "image/gif", width: 320, height: 200 });
    expect(sniffImage(jpeg(1200, 630))).toEqual({
      type: "image/jpeg",
      width: 1200,
      height: 630,
    });
    expect(sniffImage(webpLossy(800, 450))).toEqual({
      type: "image/webp",
      width: 800,
      height: 450,
    });
    expect(sniffImage(webpLossless(16, 9))).toEqual({
      type: "image/webp",
      width: 16,
      height: 9,
    });
    expect(sniffImage(webpExtended(4000, 3000))).toEqual({
      type: "image/webp",
      width: 4000,
      height: 3000,
    });
    expect(sniffImage(avif(1920, 1080))).toEqual({
      type: "image/avif",
      width: 1920,
      height: 1080,
    });
    expect(sniffImage(gif(1, 1))).toEqual({ type: "image/gif", width: 1, height: 1 });
  });

  it("knows no SVG, HTML or truncated header as an image", () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from("<!doctype html><html><body>hi</body></html>"))).toBeNull();
    expect(sniffImage(png(10, 10).subarray(0, 20))).toBeNull();
    expect(sniffImage(jpeg(10, 10).subarray(0, 24))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    // An ISO-BMFF file that is not AVIF (an MP4).
    const mp4 = avif(10, 10);
    mp4.write("isom", 8, "latin1");
    mp4.write("isom", 16, "latin1");
    mp4.write("iso2", 20, "latin1");
    expect(sniffImage(mp4)).toBeNull();
  });
});
