import { z } from "zod";

/**
 * A custom site rule: which repeating card on a page is one feed item
 * and where its fields are (design: docs/design/rule-picker.md).
 *
 * A rule is data, not code: selectors only ever reach
 * `querySelectorAll`, URL patterns only ever get compared, there is no
 * script and no URL template. That is what makes importing someone
 * else's rule safe — the worst a rule can do is pick the wrong
 * elements. Fetch history, health counters and permission state are
 * kept apart (extension storage) and never exported.
 *
 * `nmcRule` is the schema version; a change that old rules cannot be
 * read under raises it and gets migration code in `parseSiteRule`.
 */
export const SITE_RULE_VERSION = 1;

/** Longest selector a rule may carry (a picked selector is far shorter). */
export const MAX_SELECTOR_CHARS = 200;

/** Largest rule JSON `parseSiteRule` accepts. */
export const MAX_RULE_JSON_BYTES = 64 * 1024;

/**
 * Structural checks only — real CSS syntax is checked where a DOM is
 * (the engine reports an invalid selector instead of throwing). `:has()`
 * may not nest: one level is all the picker writes, and nesting is
 * where selector cost explodes.
 */
function checkSelector(selector: string, ctx: z.RefinementCtx): void {
  const control = Array.from(selector).some((ch) => ch.charCodeAt(0) < 0x20);
  // `{`, `}` and `;` are declaration noise, but only outside quotes:
  // `[data-x="a;b"]` is a valid selector.
  const unquoted = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  if (control || /[{};]/.test(unquoted)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not a CSS selector" });
    return;
  }
  const open: boolean[] = [];
  let quote: string | null = null;
  let unbalanced = false;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "\\") {
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      const isHas = /:has$/i.test(selector.slice(0, i));
      if (isHas && open.includes(true)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: ":has() cannot nest" });
        return;
      }
      open.push(isHas);
    } else if (ch === ")") {
      if (open.pop() === undefined) {
        unbalanced = true;
        break;
      }
    }
  }
  if (unbalanced || quote || open.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unbalanced quotes or parentheses" });
  }
}

export const SelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SELECTOR_CHARS)
  .superRefine(checkSelector);

const HttpUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), "must be an http(s) URL");

/**
 * Where a rule applies, without a scheme:
 * "host/path" (this page only), "host/path/*" (the page and everything
 * below it), "host/*" (the whole site). `*` only as the last segment.
 */
export const UrlPatternSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s*?#]*)?(?:\/\*)?$/i,
    'must look like "host/path", "host/path/*" or "host/*"',
  );

/** A field, relative to its card. ":scope" is the card itself. */
export const RuleFieldSchema = z.object({
  selector: SelectorSchema,
  /** Read this attribute instead of the text ("href", "datetime", "src", …). */
  attr: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "attribute names are lowercase letters, digits and '-'")
    .optional(),
});
export type RuleField = z.infer<typeof RuleFieldSchema>;

export const RULE_FIELD_NAMES = ["title", "text", "link", "author", "time", "image"] as const;
export type RuleFieldName = (typeof RULE_FIELD_NAMES)[number];

export const RuleFieldsSchema = z.object({
  title: RuleFieldSchema.optional(),
  text: RuleFieldSchema.optional(),
  /** Default attr "href"; relative links resolve against the page. */
  link: RuleFieldSchema.optional(),
  author: RuleFieldSchema.optional(),
  /** Default attr "datetime" when the element has one, else its text. */
  time: RuleFieldSchema.optional(),
  /** Default attr "src" (then "data-src", "srcset"). */
  image: RuleFieldSchema.optional(),
});
export type RuleFields = z.infer<typeof RuleFieldsSchema>;

/**
 * How items are collected. `auto`: the feed when the rule has one,
 * else the page. `rss`: the site's RSS/Atom feed (`rssUrl`), no
 * selectors needed. `static`: fetch the HTML and run the selectors on
 * it. `page`: open the page in a hidden window (JS-drawn pages, button
 * or scroll pagination). `request`: read the page's own "more items"
 * response that matches `request.match` — listened to, never built.
 */
export const COLLECT_METHODS = ["auto", "rss", "static", "request", "page"] as const;
export type CollectMethod = (typeof COLLECT_METHODS)[number];

export const CollectSchema = z.object({
  method: z.enum(COLLECT_METHODS),
  rssUrl: HttpUrlSchema.optional(),
  request: z
    .object({
      match: UrlPatternSchema,
      format: z.enum(["html", "json"]),
    })
    .optional(),
});
export type Collect = z.infer<typeof CollectSchema>;

const MaxPagesSchema = z.number().int().min(1).max(10);

export const PaginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("scroll"), maxPages: MaxPagesSchema }),
  z.object({
    type: z.literal("load-more"),
    selector: SelectorSchema,
    maxPages: MaxPagesSchema,
  }),
  z.object({
    type: z.literal("next-page"),
    selector: SelectorSchema,
    maxPages: MaxPagesSchema,
  }),
]);
export type Pagination = z.infer<typeof PaginationSchema>;

export const RuleHealthThresholdsSchema = z.object({
  /** Fewer items than this in one fetch is "few items". */
  minItems: z.number().int().min(1).max(500).default(3),
  /** A set field found in fewer than this share of items is "low coverage". */
  minCoverage: z.number().min(0).max(1).default(0.5),
});

export const SiteRuleSchema = z
  .object({
    nmcRule: z.literal(SITE_RULE_VERSION),
    /** Host + path of `url`, e.g. "news.example/world". */
    id: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(80),
    /** The page collection starts from. */
    url: HttpUrlSchema,
    /** Same host as `url`; see `UrlPatternSchema`. */
    match: z.array(UrlPatternSchema).min(1).max(20),
    /** The repeating card. Absent only for a feed-only rule. */
    item: z
      .object({
        selector: SelectorSchema,
        /** A card matching any of these is dropped: ".ad-card", ":has(.sponsor)". */
        exclude: z.array(SelectorSchema).max(20).default([]),
      })
      .optional(),
    fields: RuleFieldsSchema.optional(),
    /** Elements inside a card whose text is left out of every field ("Subscribe →"). */
    exclude: z.object({ within: z.array(SelectorSchema).max(20).default([]) }).default({}),
    collect: CollectSchema,
    pagination: PaginationSchema.default({ type: "none" }),
    health: RuleHealthThresholdsSchema.default({}),
    /** Who wrote the rule: the user in the picker, or an accepted Claude suggestion. */
    origin: z.enum(["manual", "claude"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((rule, ctx) => {
    const host = hostOf(rule.url);
    rule.match.forEach((pattern, index) => {
      if (host !== undefined && patternHost(pattern) !== host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["match", index],
          message: `must be on the rule's own host (${host})`,
        });
      }
    });
    if (rule.collect.request && host !== undefined) {
      if (patternHost(rule.collect.request.match) !== host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["collect", "request", "match"],
          message: `must be on the rule's own host (${host})`,
        });
      }
    }
    const { method, rssUrl, request } = rule.collect;
    if (method === "rss" && !rssUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collect", "rssUrl"],
        message: 'required when the method is "rss"',
      });
    }
    if (method === "request" && !request) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collect", "request"],
        message: 'required when the method is "request"',
      });
    }
    const needsSelectors = method !== "rss" && !(method === "auto" && rssUrl);
    if (needsSelectors && !rule.item) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["item"],
        message: "required unless the rule reads a feed",
      });
    }
    if (rule.item && !rule.fields?.title && !rule.fields?.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields"],
        message: "a card needs a title or a text field",
      });
    }
  });
export type SiteRule = z.infer<typeof SiteRuleSchema>;
/** A rule as written by hand or imported: the defaulted parts may be left out. */
export type SiteRuleInput = z.input<typeof SiteRuleSchema>;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function patternHost(pattern: string): string {
  const slash = pattern.indexOf("/");
  return (slash < 0 ? pattern : pattern.slice(0, slash)).toLowerCase();
}

/** "/a/b/" → "/a/b"; "" → "/". */
function trimPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** True when `url` is under `pattern` (host case-insensitive, trailing "/" ignored). */
export function urlMatchesPattern(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const slash = pattern.indexOf("/");
  if (patternHost(pattern) !== parsed.host.toLowerCase()) return false;
  const rawPath = slash < 0 ? "/" : pattern.slice(slash);
  const path = trimPath(parsed.pathname);
  if (rawPath.endsWith("/*")) {
    const prefix = trimPath(rawPath.slice(0, -2));
    return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === trimPath(rawPath);
}

/** True when any of the rule's patterns covers `url`. */
export function ruleMatchesUrl(rule: Pick<SiteRule, "match">, url: string): boolean {
  return rule.match.some((pattern) => urlMatchesPattern(pattern, url));
}

/**
 * The three pattern choices offered for an address (design decision 9,
 * default "section"). Query and fragment are dropped.
 */
export function patternsFor(url: string): { page: string; section: string; site: string } {
  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  const path = trimPath(parsed.pathname);
  const page = `${host}${path}`;
  return {
    page,
    section: path === "/" ? `${host}/*` : `${page}/*`,
    site: `${host}/*`,
  };
}

/** The rule id for an address: host + path ("news.example/world"). */
export function ruleIdFor(url: string): string {
  return patternsFor(url).page.replace(/\/$/, "");
}

export type ParseSiteRuleResult =
  { ok: true; rule: SiteRule } | { ok: false; errors: string[] };

/**
 * Import: a rule from JSON text (or an already parsed value), fully
 * checked. Never throws; on failure every problem comes back as one
 * readable line ("fields.link.attr: …") for the import dialog.
 */
export function parseSiteRule(input: unknown): ParseSiteRuleResult {
  let value = input;
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).length;
    if (bytes > MAX_RULE_JSON_BYTES) {
      return {
        ok: false,
        errors: [`rule is ${bytes} bytes; the limit is ${MAX_RULE_JSON_BYTES}`],
      };
    }
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["a rule is a JSON object"] };
  }
  const version = (value as { nmcRule?: unknown }).nmcRule;
  if (typeof version === "number" && version > SITE_RULE_VERSION) {
    return {
      ok: false,
      errors: [
        `nmcRule: made by a newer version (rule format ${version}; this app reads ${SITE_RULE_VERSION})`,
      ],
    };
  }
  const parsed = SiteRuleSchema.safeParse(value);
  if (parsed.success) return { ok: true, rule: parsed.data };
  return { ok: false, errors: formatIssues(parsed.error) };
}

/** Export: the rule as pretty JSON, after the same validation as import. */
export function serializeSiteRule(rule: SiteRuleInput): string {
  return JSON.stringify(SiteRuleSchema.parse(rule), null, 2);
}

function formatIssues(error: z.ZodError): string[] {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(rule)";
    return `${path}: ${issue.message}`;
  });
  return [...new Set(lines)];
}
