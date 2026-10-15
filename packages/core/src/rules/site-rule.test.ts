import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_RULE_JSON_BYTES,
  parseSiteRule,
  patternsFor,
  ruleIdFor,
  ruleMatchesUrl,
  serializeSiteRule,
  SiteRuleSchema,
  type SiteRuleInput,
  urlMatchesPattern,
} from "./site-rule.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** The design doc's example rule, in the shape this schema took. */
const newsRule = JSON.parse(
  readFileSync(join(fixtures, "sites", "news.rule.json"), "utf8"),
) as SiteRuleInput;

function errorsOf(input: unknown): string[] {
  const result = parseSiteRule(input);
  return result.ok ? [] : result.errors;
}

describe("SiteRuleSchema", () => {
  it("accepts the example rule and fills defaults", () => {
    const rule = SiteRuleSchema.parse({
      ...newsRule,
      pagination: undefined,
      health: undefined,
    });
    expect(rule.pagination).toEqual({ type: "none" });
    expect(rule.health).toEqual({ minItems: 3, minCoverage: 0.5 });
    expect(rule.item?.exclude).toEqual([":has(.np-sponsor)"]);
  });

  it("accepts a feed-only rule without selectors", () => {
    const feedOnly = {
      ...newsRule,
      item: undefined,
      fields: undefined,
      collect: { method: "rss", rssUrl: "https://feeds.example.invalid/gundem.xml" },
    };
    expect(errorsOf(feedOnly)).toEqual([]);
    expect(
      errorsOf({ ...feedOnly, collect: { method: "auto", rssUrl: feedOnly.collect.rssUrl } }),
    ).toEqual([]);
  });

  it("explains every problem on its own line", () => {
    const errors = errorsOf({
      ...newsRule,
      url: "ftp://haber.example.invalid/gundem",
      match: ["other.example.invalid/*", "haber.example.invalid/a*b"],
      item: { selector: "article:has(.a:has(.b))" },
      fields: { link: { selector: "a{color:red}", attr: "HREF" } },
      collect: { method: "rss" },
      pagination: { type: "load-more", maxPages: 50 },
      origin: "robot",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "url: must be an http(s) URL",
        'match.1: must look like "host/path", "host/path/*" or "host/*"',
        "item.selector: :has() cannot nest",
        "fields.link.selector: not a CSS selector",
        "fields.link.attr: attribute names are lowercase letters, digits and '-'",
        "pagination.selector: Required",
        "pagination.maxPages: Number must be less than or equal to 10",
        expect.stringMatching(/^origin: Invalid enum value/),
      ]),
    );
  });

  it("checks the cross-field rules", () => {
    expect(errorsOf({ ...newsRule, match: ["other.example.invalid/*"] })).toEqual([
      "match.0: must be on the rule's own host (haber.example.invalid)",
    ]);
    expect(errorsOf({ ...newsRule, collect: { method: "rss" } })).toEqual([
      'collect.rssUrl: required when the method is "rss"',
    ]);
    expect(errorsOf({ ...newsRule, collect: { method: "request" } })).toEqual([
      'collect.request: required when the method is "request"',
    ]);
    expect(
      errorsOf({
        ...newsRule,
        collect: {
          method: "request",
          request: { match: "api.example.invalid/more", format: "json" },
        },
      }),
    ).toEqual([
      "collect.request.match: must be on the rule's own host (haber.example.invalid)",
    ]);
    expect(errorsOf({ ...newsRule, item: undefined })).toEqual([
      "item: required unless the rule reads a feed",
    ]);
    expect(errorsOf({ ...newsRule, fields: { link: { selector: "a" } } })).toEqual([
      "fields: a card needs a title or a text field",
    ]);
  });

  it("rejects unbalanced selectors", () => {
    for (const selector of ["a[href='x", "div:not(.a", "div)"]) {
      expect(errorsOf({ ...newsRule, item: { selector } })).toEqual([
        "item.selector: unbalanced quotes or parentheses",
      ]);
    }
    expect(errorsOf({ ...newsRule, item: { selector: "a[title='(x']:has(.b)" } })).toEqual([]);
  });
});

describe("parseSiteRule / serializeSiteRule", () => {
  it("round-trips through JSON", () => {
    const json = serializeSiteRule(newsRule);
    const parsed = parseSiteRule(json);
    expect(parsed).toEqual({ ok: true, rule: SiteRuleSchema.parse(newsRule) });
  });

  it("reports bad JSON, wrong shapes, size and newer versions", () => {
    expect(errorsOf("{not json")[0]).toMatch(/^not valid JSON: /);
    expect(errorsOf("[]")).toEqual(["a rule is a JSON object"]);
    expect(errorsOf(" ".repeat(MAX_RULE_JSON_BYTES + 1))[0]).toMatch(/limit is 65536/);
    expect(errorsOf({ ...newsRule, nmcRule: 2 })).toEqual([
      "nmcRule: made by a newer version (rule format 2; this app reads 1)",
    ]);
    expect(errorsOf({ ...newsRule, nmcRule: undefined })[0]).toMatch(/^nmcRule: /);
  });
});

describe("URL patterns", () => {
  it("offers page, section and site patterns", () => {
    expect(patternsFor("https://Haber.example.invalid/gundem/?a=1#x")).toEqual({
      page: "haber.example.invalid/gundem",
      section: "haber.example.invalid/gundem/*",
      site: "haber.example.invalid/*",
    });
    expect(patternsFor("https://haber.example.invalid/")).toEqual({
      page: "haber.example.invalid/",
      section: "haber.example.invalid/*",
      site: "haber.example.invalid/*",
    });
    expect(ruleIdFor("https://haber.example.invalid/gundem/")).toBe(
      "haber.example.invalid/gundem",
    );
    expect(ruleIdFor("https://haber.example.invalid/")).toBe("haber.example.invalid");
  });

  it("matches URLs against patterns", () => {
    const section = "haber.example.invalid/gundem/*";
    expect(urlMatchesPattern(section, "https://haber.example.invalid/gundem")).toBe(true);
    expect(urlMatchesPattern(section, "https://HABER.example.invalid/gundem/2?p=2")).toBe(true);
    expect(urlMatchesPattern(section, "https://haber.example.invalid/gundemler")).toBe(false);
    expect(urlMatchesPattern(section, "https://other.example.invalid/gundem")).toBe(false);
    expect(
      urlMatchesPattern("haber.example.invalid/gundem", "http://haber.example.invalid/gundem/"),
    ).toBe(true);
    expect(
      urlMatchesPattern(
        "haber.example.invalid/gundem",
        "https://haber.example.invalid/gundem/2",
      ),
    ).toBe(false);
    expect(
      urlMatchesPattern("haber.example.invalid/*", "https://haber.example.invalid/x/y"),
    ).toBe(true);
    expect(urlMatchesPattern("haber.example.invalid/*", "ftp://haber.example.invalid/x")).toBe(
      false,
    );
    expect(urlMatchesPattern("haber.example.invalid/*", "not a url")).toBe(false);
    expect(
      ruleMatchesUrl(SiteRuleSchema.parse(newsRule), "https://haber.example.invalid/gundem/3"),
    ).toBe(true);
  });
});
