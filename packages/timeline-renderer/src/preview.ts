import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TimelineDocSchema, UI_LANGS } from "@nmc/core";
import { renderTimeline } from "./render.js";
import { stateDocs } from "./state-docs.js";

/**
 * Local preview: core's synthetic TimelineDoc fixtures (X only, and the
 * mixed X/Instagram/generic feed) → one HTML page per state and
 * language (English: `<name>.html`, Turkish: `<name>.tr.html`), written to
 * the package's git-ignored `preview.local/`. Prints the paths.
 *
 *   pnpm --filter @nmc/timeline-renderer preview
 */

const outDir = fileURLToPath(new URL("../preview.local/", import.meta.url));
await mkdir(outDir, { recursive: true });
for (const [name, prefix] of [
  ["timeline-doc.json", "timeline"],
  ["timeline-doc-mixed.json", "timeline-mixed"],
] as const) {
  const fixture = new URL(`../../core/fixtures/${name}`, import.meta.url);
  const doc = TimelineDocSchema.parse(JSON.parse(await readFile(fixture, "utf8")));
  for (const [state, stateDoc] of Object.entries(stateDocs(doc))) {
    for (const lang of UI_LANGS) {
      const name = state === "ok" ? prefix : `${prefix}-${state}`;
      const file = join(outDir, lang === "en" ? `${name}.html` : `${name}.${lang}.html`);
      await writeFile(file, renderTimeline(stateDoc, { lang }), "utf8");
      console.log(`${prefix} ${state} ${lang}: ${file}`);
    }
  }
}
