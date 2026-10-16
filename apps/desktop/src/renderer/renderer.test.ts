// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initialStatus, type CollectionSite, type DesktopStatus } from "../shared/status.js";

/** The monitor page as main loads it, driven by pushed statuses. */
let push: (status: DesktopStatus) => void = () => undefined;

beforeAll(async () => {
  vi.useFakeTimers();
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.html"),
    "utf8",
  );
  document.body.innerHTML = (/<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  Object.assign(window, {
    nmc: {
      onStatus: (listener: (status: DesktopStatus) => void) => (push = listener),
      getStatus: () => new Promise(() => undefined),
    },
  });
  await import("./renderer.js");
});

function sites(count: number, status: CollectionSite["status"] = "ok"): DesktopStatus {
  const next = initialStatus();
  next.collection = {
    state: "collecting",
    message: null,
    target: null,
    count: null,
    sources: [],
    sites: Array.from({ length: count }, (_, i) => ({
      siteId: `s${i}`,
      name: `Site ${i}`,
      status,
      itemCount: 1,
    })),
  };
  return next;
}

const box = () => document.getElementById("sites") as HTMLDetailsElement;

describe("monitor site list", () => {
  it("keeps the user's open/close choice through live updates, until the list hides", () => {
    // Five sites: folded at first; the user opens them, and updates leave it so.
    push(sites(5));
    expect(box().hidden).toBe(false);
    expect(box().open).toBe(false);
    box().open = true;
    push(sites(5));
    push(sites(5, "collecting"));
    expect(box().open).toBe(true);

    // Few sites: open at first; the user folds them, and updates leave it so.
    push(sites(2));
    expect(box().open).toBe(true);
    box().open = false;
    push(sites(2));
    expect(box().open).toBe(false);

    // The list hides: the next one starts from its own default again.
    push(initialStatus());
    expect(box().hidden).toBe(true);
    push(sites(2));
    expect(box().hidden).toBe(false);
    expect(box().open).toBe(true);
  });

  it("reads out a prefix only for a site that went wrong", () => {
    const status = sites(2);
    status.collection.sites![1]!.status = "timeout";
    push(status);
    const rows = [...document.querySelectorAll("#sites-list li")];
    expect(rows.map((row) => row.querySelector(".sr-only")?.textContent ?? null)).toEqual([
      null,
      "Incomplete: ",
    ]);
  });
});
