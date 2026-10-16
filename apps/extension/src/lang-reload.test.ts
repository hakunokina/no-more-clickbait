import { describe, expect, it, vi } from "vitest";
import { createLangReloader, createStatusLine } from "./lang-reload.js";

function harness(busy = false) {
  const state = { busy };
  const deps = {
    pageLang: () => "en" as const,
    busy: () => state.busy,
    reload: vi.fn(),
    notePending: vi.fn(),
  };
  return { state, deps, reloader: createLangReloader(deps) };
}

describe("Options language reload", () => {
  it("reloads a page with nothing in progress, once", () => {
    const { deps, reloader } = harness();
    reloader.changed("tr");
    reloader.settle();
    reloader.changed("tr");
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.notePending).not.toHaveBeenCalled();
  });

  it("waits while the page is busy, then reloads once when it settles", () => {
    const { state, deps, reloader } = harness(true);
    reloader.changed("tr");
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.notePending).toHaveBeenLastCalledWith(true);
    expect(reloader.pending()).toBe(true);
    reloader.settle();
    expect(deps.reload).not.toHaveBeenCalled();
    state.busy = false;
    reloader.settle();
    reloader.settle();
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(reloader.pending()).toBe(false);
  });

  it("does nothing for the page's own language, or when changed back before it settled", () => {
    const { state, deps, reloader } = harness(true);
    reloader.changed("en");
    reloader.settle();
    expect(deps.notePending).not.toHaveBeenCalled();
    reloader.changed("tr");
    reloader.changed("en");
    expect(deps.notePending).toHaveBeenLastCalledWith(false);
    state.busy = false;
    reloader.settle();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("keeps the waiting note through later status lines, then reloads once when Sites settles", () => {
    // Options with a delete's Undo window open in Sites when the desktop's language arrives.
    const sites = { busy: true };
    const el = { textContent: "" as string | null };
    const line = createStatusLine(el, () => "Language waits.");
    const reload = vi.fn();
    const reloader = createLangReloader({
      pageLang: () => "en",
      busy: () => sites.busy,
      reload,
      notePending: (pending) => line.notePending(pending),
    });
    line.say("Saved.");
    reloader.changed("tr");
    expect(el.textContent).toBe("Saved. Language waits.");
    // The desktop's settings push lands on a clean form.
    line.say("Updated from the desktop app.");
    expect(el.textContent).toBe("Updated from the desktop app. Language waits.");
    reloader.settle();
    expect(el.textContent).toBe("Updated from the desktop app. Language waits.");
    expect(reload).not.toHaveBeenCalled();
    sites.busy = false;
    reloader.settle();
    reloader.settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("drops the note when the language changes back before the page settled", () => {
    const el = { textContent: "" as string | null };
    const line = createStatusLine(el, () => "Language waits.");
    const reloader = createLangReloader({
      pageLang: () => "en",
      busy: () => true,
      reload: vi.fn(),
      notePending: (pending) => line.notePending(pending),
    });
    reloader.changed("tr");
    expect(el.textContent).toBe("Language waits.");
    reloader.changed("en");
    expect(el.textContent).toBe("");
    line.say("Saved.");
    expect(el.textContent).toBe("Saved.");
  });
});
