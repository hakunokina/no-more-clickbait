// Bundles main (ESM), preload (CJS — required for sandboxed preloads)
// and the renderer into dist/.
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

await build({
  entryPoints: [join(root, "src/preload/preload.ts")],
  outfile: join(dist, "preload.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: [join(root, "src/renderer/renderer.ts")],
  outfile: join(dist, "renderer/renderer.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
});

await cp(join(root, "src/renderer/index.html"), join(dist, "renderer/index.html"));
console.log(`Desktop app built to ${dist}`);
