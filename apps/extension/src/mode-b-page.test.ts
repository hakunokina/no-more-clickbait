import { describe, expect, it } from "vitest";
import { classifyPage, type PageFacts } from "./mode-b-page.js";

const facts = (overrides: Partial<PageFacts> = {}): PageFacts => ({
  pathname: "/home",
  hasLoginControl: false,
  hasRetryButton: false,
  cellCount: 12,
  ...overrides,
});

describe("classifyPage", () => {
  it("sees a loaded or still-loading home timeline", () => {
    expect(classifyPage(facts())).toBe("timeline");
    expect(classifyPage(facts({ cellCount: 0 }))).toBe("loading");
  });

  it("sees the logged-out landing and login flows", () => {
    expect(classifyPage(facts({ pathname: "/" }))).toBe("login");
    expect(classifyPage(facts({ pathname: "/login" }))).toBe("login");
    expect(classifyPage(facts({ pathname: "/i/flow/login" }))).toBe("login");
    expect(classifyPage(facts({ hasLoginControl: true }))).toBe("login");
  });

  it("sees X's retry (error / rate-limit) state", () => {
    expect(classifyPage(facts({ hasRetryButton: true }))).toBe("error");
  });

  it("sees a tab that left the home timeline", () => {
    expect(classifyPage(facts({ pathname: "/someone/status/1" }))).toBe("away");
    expect(classifyPage(facts({ pathname: "/loginhelp" }))).toBe("away");
  });
});
