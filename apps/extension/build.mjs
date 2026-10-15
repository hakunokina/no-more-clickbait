// Builds the unpacked extension into dist/ (load that folder in
// chrome://extensions or brave://extensions with Developer mode on).
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [
    "injected",
    "content",
    "reddit-injected",
    "reddit-content",
    "instagram-injected",
    "instagram-content",
    "background",
    "options",
    "popup",
    "offscreen",
    "picker",
    "site-hook",
    "site-relay",
    "sites/site-content",
  ].map((name) => ({ in: join(root, "src", `${name}.ts`), out: name.replace(/^sites\//, "") })),
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
});

await cp(join(root, "public"), dist, { recursive: true });

// chrome.i18n messages from src/i18n/messages.ts: positional "$1"… become
// named placeholders ("$P1$" with content "$1"), as _locales expects.
const tmp = join(dist, ".messages.mjs");
await build({
  entryPoints: [join(root, "src", "i18n", "messages.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const { LOCALES } = await import(pathToFileURL(tmp).href);
await rm(tmp, { force: true });
for (const [lang, messages] of Object.entries(LOCALES)) {
  const out = {};
  for (const [key, text] of Object.entries(messages)) {
    const placeholders = {};
    const message = text.replace(/\$([1-9])/g, (_, n) => {
      placeholders[`p${n}`] = { content: `$${n}` };
      return `$P${n}$`;
    });
    out[key] = Object.keys(placeholders).length > 0 ? { message, placeholders } : { message };
  }
  await mkdir(join(dist, "_locales", lang), { recursive: true });
  await writeFile(
    join(dist, "_locales", lang, "messages.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
}

console.log(`Extension built to ${dist}`);
