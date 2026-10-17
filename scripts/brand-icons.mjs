// Renders the brand mark (docs/design/brand) into the app icons:
// extension PNGs and the desktop .ico. Run with `pnpm brand:icons` after
// changing the SVGs; the outputs are committed, so builds never need this.
// nmc-mark-16.svg is pixel-hinted for exactly 16 px; every other size
// comes from nmc-mark.svg.
import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "docs/design/brand");
const mark = await readFile(join(brand, "nmc-mark.svg"));
const mark16 = await readFile(join(brand, "nmc-mark-16.svg"));

function render(size) {
  const svg = size === 16 ? mark16 : mark;
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
}

for (const size of [16, 32, 48, 128]) {
  const out = join(root, "apps/extension/public", `icon-${size}.png`);
  await writeFile(out, render(size).asPng());
  console.log(out);
}

// Classic ICO layout: 32-bit BMP (DIB) frames up to 64 px, PNG for 256.
function dibFrame(image) {
  const { width: w, height: h } = image;
  const rgba = image.pixels; // premultiplied RGBA, top-down
  const maskRow = Math.ceil(w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = ((h - 1 - y) * w + x) * 4; // bottom-up
      const a = rgba[src + 3];
      const un = (c) => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
      xor[dst] = un(rgba[src + 2]);
      xor[dst + 1] = un(rgba[src + 1]);
      xor[dst + 2] = un(rgba[src]);
      xor[dst + 3] = a;
    }
  }
  // All-zero AND mask: the alpha channel carries transparency.
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * h)]);
}

const sizes = [16, 24, 32, 48, 64, 256];
const frames = sizes.map((size) => {
  const image = render(size);
  return size === 256 ? image.asPng() : dibFrame(image);
});
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  dir.writeUInt8(size === 256 ? 0 : size, at);
  dir.writeUInt8(size === 256 ? 0 : size, at + 1);
  dir.writeUInt16LE(1, at + 4); // planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(frames[i].length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += frames[i].length;
});
const ico = join(root, "apps/desktop/assets/nmc.ico");
await writeFile(ico, Buffer.concat([dir, ...frames]));
console.log(ico);
