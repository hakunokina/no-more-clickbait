import { describe, expect, it, vi } from "vitest";
import { createLangReloader } from "./lang-reload.js";

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
});
