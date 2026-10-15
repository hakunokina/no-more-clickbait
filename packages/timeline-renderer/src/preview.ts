import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TimelineDocSchema } from "@nmc/core";
import { renderTimeline } from "./render.js";
import { stateDocs } from "./state-docs.js";

/**
 * Local preview: core's synthetic TimelineDoc fixture → one HTML page
 * per state, written to the package's git-ignored `preview.local/`.
 * Prints the paths.
 *
 *   pnpm --filter @nmc/timeline-renderer preview
 */

const fixture = new URL("../../core/fixtures/timeline-doc.json", import.meta.url);
const doc = TimelineDocSchema.parse(JSON.parse(await readFile(fixture, "utf8")));
const outDir = fileURLToPath(new URL("../preview.local/", import.meta.url));
await mkdir(outDir, { recursive: true });
for (const [state, stateDoc] of Object.entries(stateDocs(doc))) {
  const file = join(outDir, state === "ok" ? "timeline.html" : `timeline-${state}.html`);
  await writeFile(file, renderTimeline(stateDoc), "utf8");
  console.log(`${state}: ${file}`);
}
