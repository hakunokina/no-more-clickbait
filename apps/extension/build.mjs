// Builds the unpacked extension into dist/ (load that folder in
// chrome://extensions or brave://extensions with Developer mode on).
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: ["injected", "content", "background", "options", "popup"].map((name) =>
    join(root, "src", `${name}.ts`),
  ),
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
});

await cp(join(root, "public"), dist, { recursive: true });
console.log(`Extension built to ${dist}`);
