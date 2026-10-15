import {
  distinguishing,
  fieldSelectorForResult,
  inferItem,
  RULE_FIELD_NAMES,
  ruleIdFor,
  selectorFor,
  type Collect,
  type Pagination,
  type RuleField,
  type RuleFieldName,
  type SiteRule,
  type SiteRuleInput,
} from "@nmc/core";
import type { MessageKey, Msg } from "../i18n.js";

/**
 * The picker's selection, over the live page (design: rule-picker.md,
 * decisions 2–6). Pure DOM reading: nothing on the page is changed — the
 * highlight layer only draws where these elements are. Selector writing
 * is core's (`inferItem`, `fieldSelectorForResult`, `distinguishing`),
 * the same rules the collection engine reads.
 */

export type Role = "card" | RuleFieldName | "cut";
export const ROLES: readonly Role[] = ["card", ...RULE_FIELD_NAMES, "cut"];
export const FIELD_ROLES: readonly RuleFieldName[] = RULE_FIELD_NAMES;

/** Fixed role colours (theme-independent, design table) and their letter keys. */
export const ROLE_COLORS: Record<Role, string> = {
  card: "#0b57d0",
  title: "#6b2fbf",
  text: "#176934",
  link: "#0b6e79",
  author: "#8a4b00",
  time: "#a1306b",
  image: "#3f4f5e",
  cut: "#b3261e",
};

/** Each role's name in the UI language. */
export const ROLE_NAME_KEYS: Record<Role, MessageKey> = {
  card: "roleCard",
  title: "roleTitle",
  text: "roleText",
  link: "roleLink",
  author: "roleAuthor",
  time: "roleTime",
  image: "roleImage",
  cut: "roleCut",
};

/** A card exclusion written into the rule (`item.exclude`), with what the user saw. */
export interface CardExclusion {
  selector: string;
  /** Short visible text of the distinguishing element ("Sponsored"). */
  label: string;
}

export type AssignResult =
  { ok: true; msg: Msg[]; undo?: () => void; warn?: boolean } | { ok: false; msg: Msg[] };

export interface RuleMeta {
  url: string;
  pattern: string;
  name: string;
  /** Kept when re-picking an existing rule. */
  id?: string;
  collect: Collect;
  pagination: Pagination;
  minItems: number;
  createdAt: string;
  now: string;
}

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function queryOne(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

export class PickerModel {
  card: string | null = null;
  fields: Partial<Record<RuleFieldName, RuleField>> = {};
  excludes: CardExclusion[] = [];
  /** "Not this card" without a writable feature: visible on this page only. */
  notThis = new Set<Element>();
  /** Parts cut out of every card's text (`exclude.within`). */
  strip: string[] = [];
  /** "Cut" outside the cards: feedback only, never written. */
  outside: Element[] = [];
  dirty = false;

  /**
   * `root` is the page document; `isPage` tells page elements from the
   * picker's own (its shadow host lives in the same document).
   */
  constructor(
    readonly root: Document,
    readonly isPage: (el: Element) => boolean,
  ) {}

  reset(): void {
    this.card = null;
    this.fields = {};
    this.excludes = [];
    this.notThis = new Set();
    this.strip = [];
    this.outside = [];
    this.dirty = false;
  }

  allCards(): Element[] {
    return this.card ? queryAll(this.root, this.card).filter(this.isPage) : [];
  }

  isExcluded(card: Element): boolean {
    return this.notThis.has(card) || this.excludes.some((ex) => matchesSafe(card, ex.selector));
  }

  /** The exclusion that drops `card`, when one does. */
  exclusionOf(card: Element): CardExclusion | undefined {
    return this.excludes.find((ex) => matchesSafe(card, ex.selector));
  }

  keptCards(): Element[] {
    return this.allCards().filter((card) => !this.isExcluded(card));
  }

  /** The card holding `el` (itself included), when it is one of the kept cards. */
  cardOf(el: Element): Element | null {
    if (!this.card) return null;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (matchesSafe(node, this.card) && this.isPage(node)) {
        return this.isExcluded(node) ? null : node;
      }
    }
    return null;
  }

  /** What the engine reads for a field in a card (first match, or the card for ":scope"). */
  fieldEl(card: Element, key: RuleFieldName): Element | null {
    const field = this.fields[key];
    if (!field) return null;
    if (field.selector === ":scope") return card;
    return queryOne(card, field.selector);
  }

  coverage(key: RuleFieldName): { n: number; of: number } | null {
    const kept = this.keptCards();
    if (!this.fields[key] || kept.length === 0) return null;
    return { n: kept.filter((card) => this.fieldEl(card, key)).length, of: kept.length };
  }

  /** Ready for preview: a card that matches, and a title or a text. */
  ready(): boolean {
    return Boolean(
      this.card && this.keptCards().length > 0 && (this.fields.title || this.fields.text),
    );
  }

  /** The element's own selector, shown in labels ("h2.title"). */
  describe(el: Element): string {
    return selectorFor(el);
  }

  /** Look-alikes: in the kept cards for an element inside one, else on the page. */
  similarCount(el: Element): number {
    const selector = this.describe(el);
    const card = this.cardOf(el);
    if (card && card !== el) {
      return this.keptCards().filter((c) => queryOne(c, selector)).length;
    }
    return queryAll(this.root, selector).filter(this.isPage).length;
  }

  assignedRole(el: Element): Role | null {
    const card = this.cardOf(el);
    if (card === el) return "card";
    if (card) {
      for (const key of FIELD_ROLES) if (this.fieldEl(card, key) === el) return key;
      if (this.strip.some((selector) => matchesSafe(el, selector))) return "cut";
    }
    if (this.outside.includes(el)) return "cut";
    return null;
  }

  assign(role: Role, el: Element): AssignResult {
    if (role === "card") return this.assignCard(el);
    if (role === "cut") return this.assignCut(el);
    return this.assignField(role, el);
  }

  private setCard(selector: string): void {
    this.card = selector;
    this.notThis.clear();
    this.excludes = [];
    for (const key of FIELD_ROLES) {
      if (this.fields[key] && !this.keptCards().some((card) => this.fieldEl(card, key))) {
        delete this.fields[key];
      }
    }
  }

  private assignCard(el: Element): AssignResult {
    const inferred = inferItem(el, this.root);
    if (!inferred.ok) return { ok: false, msg: [{ key: "pickErrNotRepeated" }] };
    this.dirty = true;
    this.setCard(inferred.selector);
    return { ok: true, msg: [{ key: "pickCardFound", args: [this.keptCards().length] }] };
  }

  private assignCut(el: Element): AssignResult {
    if (this.card && matchesSafe(el, this.card) && this.isPage(el)) {
      this.dirty = true;
      return this.excludeCard(el);
    }
    const card = this.cardOf(el);
    if (card) {
      const own = this.describe(el);
      // A bare tag ("span") would cut every span: fall back to the exact position then.
      let selector = own;
      if (!/[.[]/.test(own)) {
        const exact = fieldSelectorForResult(el, card);
        if (!exact.ok) return { ok: false, msg: [{ key: "pickErrTooLong" }] };
        selector = exact.selector;
      }
      if (selector === ":scope") return this.excludeCard(card);
      this.dirty = true;
      if (!this.strip.includes(selector)) this.strip.push(selector);
      return { ok: true, msg: [{ key: "pickCutWithin", args: [selector] }] };
    }
    this.dirty = true;
    if (!this.outside.includes(el)) this.outside.push(el);
    return { ok: true, msg: [{ key: "pickCutOutside" }] };
  }

  private assignField(role: RuleFieldName, el: Element): AssignResult {
    const msg: Msg[] = [];
    let card = this.cardOf(el);
    if (!card) {
      const inferred = inferItem(el, this.root);
      if (!inferred.ok) return { ok: false, msg: [{ key: "pickErrNotInCard" }] };
      this.setCard(inferred.selector);
      card = this.cardOf(el);
      if (!card) return { ok: false, msg: [{ key: "pickErrNotInCard" }] };
      msg.push({ key: "pickCardInferred", args: [this.keptCards().length, inferred.selector] });
    }
    const target = adjustTarget(role, el, card);
    const written = fieldSelectorForResult(target, card);
    if (!written.ok) {
      return {
        ok: false,
        msg: [
          { key: written.reason === "outside-card" ? "pickErrNotInCard" : "pickErrTooLong" },
        ],
      };
    }
    this.dirty = true;
    this.fields[role] = withAttr(role, target, written.selector);
    if (role === "title" && !this.fields.link) {
      const anchor = target.tagName === "A" ? target : queryOne(target, "a[href]");
      const link = anchor ? fieldSelectorForResult(anchor, card) : null;
      if (link?.ok) {
        this.fields.link = { selector: link.selector, attr: "href" };
        msg.push({ key: "pickLinkFromTitle" });
      }
    }
    const cov = this.coverage(role);
    msg.push({
      key: "pickFieldCoverage",
      args: [{ key: ROLE_NAME_KEYS[role] }, cov?.n ?? 0, cov?.of ?? 0],
    });
    return { ok: true, msg };
  }

  /** "Not this card": a writable feature when there is one (decision 4), else this page only. */
  excludeCard(card: Element): AssignResult {
    const found = distinguishing(card, this.keptCards());
    if (!found.ok) {
      this.notThis.add(card);
      return { ok: true, warn: true, msg: [{ key: "pickNotThisUnwritable" }] };
    }
    const exclusion: CardExclusion = {
      selector: found.exclude,
      label: labelFor(card, found.exclude),
    };
    this.excludes.push(exclusion);
    const n = this.allCards().filter((c) => matchesSafe(c, exclusion.selector)).length;
    return {
      ok: true,
      msg: [{ key: "pickNotThisDone", args: [n, exclusion.label] }],
      undo: () => {
        this.excludes = this.excludes.filter((ex) => ex !== exclusion);
      },
    };
  }

  /** Removes what the role holds (whole selection for "card", every cut for "cut"). */
  clearRole(role: Role): void {
    this.dirty = true;
    if (role === "card") {
      this.reset();
      this.dirty = true;
    } else if (role === "cut") {
      this.notThis.clear();
      this.excludes = [];
      this.strip = [];
      this.outside = [];
    } else {
      delete this.fields[role];
    }
  }

  /** Undoes "cut" on one element (the role window's "Remove selection"). */
  clearCutOn(el: Element): void {
    this.dirty = true;
    this.outside = this.outside.filter((x) => x !== el);
    this.strip = this.strip.filter((selector) => !matchesSafe(el, selector));
  }

  /** Loads a saved rule; says how many of its selectors still match here. */
  load(rule: SiteRule): { matching: number; total: number; cards: number } {
    this.reset();
    this.card = rule.item?.selector ?? null;
    for (const key of FIELD_ROLES) {
      const field = rule.fields?.[key];
      if (field) this.fields[key] = { ...field };
    }
    const cards = this.allCards();
    this.excludes = (rule.item?.exclude ?? []).map((selector) => {
      const sample = cards.find((card) => matchesSafe(card, selector));
      return { selector, label: sample ? labelFor(sample, selector) : selector };
    });
    this.strip = [...rule.exclude.within];
    const kept = this.keptCards();
    let total = 0;
    let matching = 0;
    if (this.card) {
      total += 1;
      if (kept.length > 0) matching += 1;
    }
    for (const key of FIELD_ROLES) {
      if (!this.fields[key]) continue;
      total += 1;
      if (kept.some((card) => this.fieldEl(card, key))) matching += 1;
    }
    for (const selector of [...this.excludes.map((ex) => ex.selector), ...this.strip]) {
      total += 1;
      if (cards.some((card) => matchesSafe(card, selector) || queryOne(card, selector))) {
        matching += 1;
      }
    }
    return { matching, total, cards: kept.length };
  }

  toRule(meta: RuleMeta): SiteRuleInput {
    const fields: Partial<Record<RuleFieldName, RuleField>> = {};
    for (const key of FIELD_ROLES) {
      const field = this.fields[key];
      if (field) fields[key] = { ...field };
    }
    return {
      nmcRule: 1,
      id: meta.id ?? ruleIdFor(meta.url),
      name: meta.name,
      url: meta.url,
      match: [meta.pattern],
      ...(this.card
        ? { item: { selector: this.card, exclude: this.excludes.map((ex) => ex.selector) } }
        : {}),
      fields,
      exclude: { within: [...this.strip] },
      collect: meta.collect,
      pagination: meta.pagination,
      health: { minItems: meta.minItems },
      origin: "manual",
      createdAt: meta.createdAt,
      updatedAt: meta.now,
    };
  }
}

/** Image → the img inside; link → the enclosing or inner anchor (within the card). */
function adjustTarget(role: RuleFieldName, el: Element, card: Element): Element {
  if (role === "image" && el.tagName !== "IMG") return queryOne(el, "img") ?? el;
  if (role === "link" && el.tagName !== "A") {
    for (
      let node: Element | null = el;
      node && node !== card.parentElement;
      node = node.parentElement
    ) {
      if (node.tagName === "A" && node.hasAttribute("href")) return node;
      if (node === card) break;
    }
    return queryOne(el, "a[href]") ?? el;
  }
  return el;
}

function withAttr(role: RuleFieldName, target: Element, selector: string): RuleField {
  if (role === "link" && target.tagName === "A") return { selector, attr: "href" };
  if (role === "time" && target.hasAttribute("datetime")) return { selector, attr: "datetime" };
  return { selector };
}

/** What the user recognizes an exclusion by: the feature element's text, else the feature. */
function labelFor(card: Element, exclude: string): string {
  const inner = /^:has\((.+)\)$/.exec(exclude)?.[1];
  const el = inner ? queryOne(card, inner) : card;
  const text = (inner ? el?.textContent : "")?.replace(/\s+/g, " ").trim() ?? "";
  return (text || inner || exclude).slice(0, 24);
}
