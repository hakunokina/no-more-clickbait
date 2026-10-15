// Bundles main (ESM), the preloads (CJS — required for sandboxed preloads)
// and the renderer pages (monitor, reading window) into dist/.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "renderer"), { recursive: true });

await build({
  entryPoints: [join(root, "src/main/main.ts")],
  outfile: join(dist, "main.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

for (const name of ["preload", "reader-preload"]) {
  await build({
    entryPoints: [join(root, `src/preload/${name}.ts`)],
    outfile: join(dist, `${name}.cjs`),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });
}

await build({
  entryPoints: [join(root, "src/renderer/renderer.ts"), join(root, "src/renderer/reader.ts")],
  outdir: join(dist, "renderer"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
});

for (const page of ["index.html", "reader.html"]) {
  await cp(join(root, "src/renderer", page), join(dist, "renderer", page));
}
console.log(`Desktop app built to ${dist}`);
