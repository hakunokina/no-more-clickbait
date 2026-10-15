import { describe, expect, it, vi } from "vitest";
import {
  hasSitePermission,
  originPattern,
  requestOrigins,
  rulesAffectedBy,
  siteOrigins,
  unusedOrigins,
  type PermissionsApi,
} from "./site-permissions.js";
import { siteRule } from "./test-fixtures.js";

/** A fake `chrome.permissions` that grants what the "user" accepts. */
function fakePermissions(accept: boolean): PermissionsApi & { granted: Set<string> } {
  const granted = new Set<string>();
  return {
    granted,
    contains: ({ origins }) => Promise.resolve(origins.every((o) => granted.has(o))),
    request: vi.fn(({ origins }: { origins: string[] }) => {
      if (accept) for (const origin of origins) granted.add(origin);
      return Promise.resolve(accept);
    }),
    remove: ({ origins }) => {
      for (const origin of origins) granted.delete(origin);
      return Promise.resolve(true);
    },
  };
}

const other = siteRule({
  id: "c.example.invalid",
  url: "https://c.example.invalid/",
  match: ["c.example.invalid/*"],
});

describe("site permissions", () => {
  it("asks for the site's own origin only — never <all_urls>, no port", () => {
    expect(originPattern("https://News.Example.invalid:8443/world?x=1")).toBe(
      "https://news.example.invalid/*",
    );
    expect(originPattern("http://blog.example.invalid/")).toBe("http://blog.example.invalid/*");
    expect(originPattern("ftp://x.example.invalid/")).toBeUndefined();
    const withFeed = siteRule({
      collect: { method: "auto", rssUrl: "https://feeds.example.invalid/world.xml" },
    });
    expect(siteOrigins(withFeed)).toEqual([
      "https://news.example.invalid/*",
      "https://feeds.example.invalid/*",
    ]);
  });

  it("grants and checks through the browser's own dialog", async () => {
    const api = fakePermissions(true);
    const rule = siteRule();
    expect(await hasSitePermission(api, rule)).toBe(false);
    expect(await requestOrigins(api, siteOrigins(rule))).toBe(true);
    expect(api.request).toHaveBeenCalledWith({ origins: ["https://news.example.invalid/*"] });
    expect(await hasSitePermission(api, rule)).toBe(true);
  });

  it("reports a refusal (or a browser error) as not granted", async () => {
    expect(await requestOrigins(fakePermissions(false), ["https://a.example.invalid/*"])).toBe(
      false,
    );
    const throwing: PermissionsApi = {
      contains: () => Promise.reject(new Error("no")),
      request: () =>
        Promise.reject(new Error("This function must be called during a user gesture")),
      remove: () => Promise.resolve(true),
    };
    expect(await requestOrigins(throwing, ["https://a.example.invalid/*"])).toBe(false);
    expect(await hasSitePermission(throwing, siteRule())).toBe(false);
    expect(await requestOrigins(throwing, [])).toBe(false);
  });

  it("gives back only origins no other rule uses", () => {
    const a = siteRule();
    const b = siteRule({
      id: "news.example.invalid/sport",
      url: "https://news.example.invalid/sport",
      match: ["news.example.invalid/sport/*"],
    });
    expect(unusedOrigins(a, [b, other])).toEqual([]);
    expect(unusedOrigins(other, [a, b])).toEqual(["https://c.example.invalid/*"]);
  });

  it("finds the rules a revoked permission hits", () => {
    expect(
      rulesAffectedBy([siteRule(), other], ["https://c.example.invalid/*"]).map((r) => r.id),
    ).toEqual(["c.example.invalid"]);
  });
});
