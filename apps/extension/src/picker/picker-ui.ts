import {
  extractItems,
  SiteRuleSchema,
  type CollectMethod,
  type GenericItem,
  type Pagination,
  type SiteRule,
  type SiteRuleInput,
} from "@nmc/core";
import { t, tm, type MessageKey, type Msg } from "../i18n.js";
import type {
  PickerTarget,
  SitePickerSaveAnswer,
  SiteProbeAnswer,
  SiteWorkerMessage,
} from "../sites/site-messages.js";
import {
  isSiteHookResponseMessage,
  PAGE_MESSAGE_SOURCE,
  type SiteHookArmMessage,
} from "../sites/hook-protocol.js";
import { append, h, icon, relativeTime, type Child, type IconName } from "./dom.js";
import {
  paginationHints,
  pickRequestCandidate,
  type PaginationHints,
  type RequestCandidate,
  type SeenResponse,
} from "./page-hints.js";
import {
  FIELD_ROLES,
  PickerModel,
  ROLE_COLORS,
  ROLE_NAME_KEYS,
  ROLES,
  type Role,
} from "./picker-model.js";
import { PICKER_CSS } from "./picker-styles.js";

/**
 * The in-page picker (design: rule-picker-mockup.html + rule-picker.md):
 * one closed shadow root on `document.documentElement`, shown in the top
 * layer (Popover API) so no page z-index covers it, styled through a
 * constructed stylesheet. The page itself is never changed — highlights
 * are drawn in an overlay at the elements' boxes. Page clicks are caught
 * in the capture phase while the picker is open (links must not
 * navigate); arrow keys only in picker context.
 */

export type PickerMode = "start" | "pick" | "preview" | "saved" | "confirm-exit";
export type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_KEYS: Record<Theme, MessageKey> = {
  system: "themeSystem",
  light: "themeLight",
  dark: "themeDark",
};
const THEME_ICONS: Record<Theme, IconName> = { system: "monitor", light: "sun", dark: "moon" };

const ROLE_LETTER_KEYS: Record<Role, MessageKey> = {
  card: "letterCard",
  title: "letterTitle",
  text: "letterText",
  link: "letterLink",
  author: "letterAuthor",
  time: "letterTime",
  image: "letterImage",
  cut: "letterCut",
};
const ROLE_HELP_KEYS: Partial<Record<Role, MessageKey>> = {
  card: "roleCardHelp",
  text: "roleTextHelp",
  link: "roleLinkHelp",
  cut: "roleCutHelp",
};

const PREVIEW_COUNT = 5;
const DETECT_WAIT_MS = 6_000;

export interface PickerEnv {
  doc: Document;
  win: Window;
  /** To the worker (`chrome.runtime.sendMessage`). */
  send(message: SiteWorkerMessage): Promise<unknown>;
  now(): string;
  loadTheme(): Promise<Theme>;
  saveTheme(theme: Theme): void;
  /** "closed" in the product; tests use "open". */
  shadowMode?: ShadowRootMode;
}

export interface PickerInit {
  target: PickerTarget;
  /** The saved rule, when re-picking. */
  rule?: SiteRule;
}

interface DrawerForm {
  name: string;
  pagination: Pagination["type"];
  maxPages: number;
  minItems: number;
  method: CollectMethod;
}

export class PickerUI {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly model: PickerModel;
  mode: PickerMode = "start";
  side: "right" | "left" = "right";
  minimized = false;
  theme: Theme = "system";
  hover: Element | null = null;
  cursor: Element | null = null;
  popTarget: Element | null = null;
  private popAnchor = { x: 0, y: 0 };
  private popMessage: Msg[] = [];
  private prevMode: PickerMode = "pick";
  private source: "manual" | "existing" = "manual";
  private existing: { matching: number; total: number } | null = null;
  private startNote: Msg | null = null;
  private hints: PaginationHints = {};
  private request: RequestCandidate | null = null;
  private detecting = false;
  private detectNote: Msg | null = null;
  private probe: SiteProbeAnswer | "checking" | null = null;
  private form: DrawerForm | null = null;
  private savedCount = 0;
  private passThrough = false;
  private raf = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private toastUndo: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];

  private readonly root: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly pill: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly live: HTMLElement;
  private readonly toast: HTMLElement;

  constructor(
    private readonly env: PickerEnv,
    private readonly init: PickerInit,
  ) {
    const { doc } = env;
    this.host = doc.createElement("div");
    this.host.setAttribute("data-nmc-picker", "");
    this.shadow = this.host.attachShadow({ mode: env.shadowMode ?? "closed" });
    this.model = new PickerModel(doc, (el) => this.isPage(el));

    const sheet = new (
      env.win as unknown as { CSSStyleSheet: typeof CSSStyleSheet }
    ).CSSStyleSheet();
    sheet.replaceSync(PICKER_CSS);
    this.shadow.adoptedStyleSheets = [sheet];

    const x = (tag: string, attrs: Record<string, string> = {}): HTMLElement =>
      h(doc, tag, attrs);
    this.root = x("div", { class: "root", lang: t("langCode") });
    this.layer = x("div", { class: "layer", "aria-hidden": "true" });
    this.panel = x("section", { class: "panel", "aria-labelledby": "p-brand" });
    this.pill = x("button", { class: "pill", type: "button" }) as HTMLButtonElement;
    this.pill.hidden = true;
    this.pop = x("div", { class: "pop", role: "dialog", "aria-labelledby": "pop-h" });
    this.pop.hidden = true;
    this.drawer = x("aside", { class: "drawer", "aria-labelledby": "d-h" });
    this.drawer.hidden = true;
    this.live = x("div", { class: "sr-only", "aria-live": "polite" });
    this.toast = x("div", { class: "note note--info sr-only" });
    append(this.root, [this.layer, this.panel, this.pill, this.pop, this.drawer, this.live]);
    this.shadow.append(this.root);
  }

  // --- lifecycle ------------------------------------------------------

  async mount(): Promise<void> {
    const { doc, win } = this.env;
    doc.documentElement.append(this.host);
    const popover = this.root as HTMLElement & { showPopover?: () => void };
    if (typeof popover.showPopover === "function") {
      this.root.setAttribute("popover", "manual");
      try {
        popover.showPopover();
      } catch {
        // Not shown as a popover: the fixed root with a high z-index still works.
        this.root.removeAttribute("popover");
      }
    }
    this.listen(doc, "mousemove", (e) => this.onMouseMove(e as MouseEvent), true);
    this.listen(doc, "click", (e) => this.onPageClick(e as MouseEvent), true);
    this.listen(doc, "keydown", (e) => this.onKeyDown(e as KeyboardEvent), true);
    this.listen(win, "scroll", () => this.repaint(), { passive: true });
    this.listen(win, "resize", () => this.repaint());
    this.listen(win, "message", (e) => this.onWindowMessage(e as MessageEvent));
    this.listen(this.shadow, "click", (e) => this.onShadowClick(e as MouseEvent));
    this.listen(this.shadow, "change", (e) => this.onShadowChange(e));
    this.listen(this.shadow, "input", (e) => this.onShadowChange(e));
    this.listen(this.pop, "keydown", (e) => this.onPopKeyDown(e as KeyboardEvent));
    this.theme = await this.env.loadTheme().catch(() => "system" as Theme);

    if (this.init.rule) {
      const loaded = this.model.load(this.init.rule);
      if (loaded.cards > 0) {
        this.existing = { matching: loaded.matching, total: loaded.total };
        this.source = "existing";
        this.model.dirty = false;
        this.mode = "pick";
        this.render(".cursorbox");
        this.announce({ key: "annExistingLoaded", args: [loaded.matching, loaded.total] });
        return;
      }
      this.model.reset();
      this.startNote = this.init.rule.item
        ? { key: "startRepickBroken", args: [this.init.rule.item.selector] }
        : null;
    }
    this.mode = "start";
    this.render("[data-p='manual']");
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    clearTimeout(this.toastTimer);
    if (this.raf) this.env.win.cancelAnimationFrame(this.raf);
    this.host.remove();
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** A page element the picker may select (not its own host, not html/body). */
  isPage(el: Element | null | undefined): el is Element {
    if (!el || el === this.host || this.host.contains(el)) return false;
    const { doc } = this.env;
    return el !== doc.documentElement && el !== doc.body && doc.documentElement.contains(el);
  }

  // --- helpers --------------------------------------------------------

  private x(
    tag: string,
    attrs: Record<string, string | number | boolean | undefined> = {},
    ...children: Child[]
  ): HTMLElement {
    return h(this.env.doc, tag, attrs, ...children);
  }

  private i(name: IconName, flip = false): SVGSVGElement {
    return icon(this.env.doc, name, flip);
  }

  announce(msg: Msg | string): void {
    const text = typeof msg === "string" ? msg : tm(msg);
    this.live.textContent = "";
    this.env.win.setTimeout(() => {
      this.live.textContent = text;
    }, 30);
  }

  /** Short feedback; announced, with an "Undo" button in the panel when given. */
  private say(msgs: Msg[], undo: (() => void) | null = null): void {
    const text = msgs.map(tm).join(" ");
    this.announce(text);
    this.toastUndo = undo;
    this.toast.textContent = "";
    this.toast.className = undo ? "note note--info" : "note note--info sr-only";
    append(this.toast, [this.x("span", { text })]);
    if (undo) {
      append(this.toast, [
        " ",
        this.x("button", {
          class: "linkbtn",
          type: "button",
          "data-p": "undo",
          text: t("undo"),
        }),
      ]);
    }
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(
      () => {
        this.toastUndo = null;
        this.toast.className = "note note--info sr-only";
      },
      undo ? 8_000 : 2_800,
    );
  }

  private q<T extends Element = HTMLElement>(selector: string): T | null {
    return this.shadow.querySelector<T>(selector);
  }

  // --- rendering ------------------------------------------------------

  render(focus?: string): void {
    this.host.toggleAttribute("data-theme", this.theme !== "system");
    if (this.theme !== "system") this.host.setAttribute("data-theme", this.theme);
    this.panel.dataset["side"] = this.side;
    this.pill.dataset["side"] = this.side;
    this.drawer.dataset["side"] = this.side;
    this.panel.replaceChildren(this.head(), ...this.view());
    this.panel.hidden = this.minimized || this.mode === "preview";
    const kept = this.model.keptCards().length;
    this.pill.hidden = !this.minimized || this.mode === "preview";
    this.pill.replaceChildren(
      this.x("span", { class: "p-logo", "aria-hidden": "true", text: "NMC" }),
      t("pillOpen", this.model.card ? t("pillCards", kept) : t("pillPicker")),
    );
    this.pill.setAttribute(
      "aria-label",
      this.model.card ? t("pillAriaCards", kept) : t("pillAria"),
    );
    if (this.mode === "preview") this.renderDrawer();
    else this.drawer.hidden = true;
    if (focus) this.q(focus)?.focus();
    this.repaint();
  }

  private head(): HTMLElement {
    const next = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length] ?? "system";
    const moveKey: MessageKey = this.side === "right" ? "panelMoveLeft" : "panelMoveRight";
    const themeLabel = t("panelTheme", t(THEME_KEYS[this.theme]), t(THEME_KEYS[next]));
    return this.x(
      "header",
      { class: "p-head" },
      this.x("span", { class: "p-logo", "aria-hidden": "true", text: "NMC" }),
      this.x(
        "div",
        { class: "p-titles" },
        this.x("div", {
          class: "p-brand",
          id: "p-brand",
          text: t(this.init.target.repickOf ? "panelTitleRepick" : "panelTitleNew"),
        }),
        this.x("div", {
          class: "p-site",
          title: this.init.target.pattern,
          text: this.init.target.pattern,
        }),
      ),
      this.x(
        "button",
        {
          class: "hbtn",
          type: "button",
          id: "p-side",
          "aria-label": t(moveKey),
          title: t(moveKey),
        },
        this.i("dock", this.side === "left"),
      ),
      this.x(
        "button",
        {
          class: "hbtn",
          type: "button",
          id: "p-theme",
          "aria-label": themeLabel,
          title: themeLabel,
        },
        this.i(THEME_ICONS[this.theme]),
      ),
      this.x(
        "button",
        {
          class: "hbtn",
          type: "button",
          id: "p-min",
          "aria-label": t("panelMinimize"),
          title: t("panelMinimizeShort"),
        },
        this.i("collapse"),
      ),
      this.x(
        "button",
        {
          class: "hbtn",
          type: "button",
          id: "p-close",
          "aria-label": t("panelClose"),
          title: t("panelCloseShort"),
        },
        this.i("close"),
      ),
    );
  }

  private view(): HTMLElement[] {
    switch (this.mode) {
      case "start":
        return this.viewStart();
      case "pick":
      case "preview":
        return this.viewPick();
      case "saved":
        return this.viewSaved();
      case "confirm-exit":
        return this.viewConfirmExit();
    }
  }

  private viewStart(): HTMLElement[] {
    const body = this.x("div", { class: "p-body" });
    if (this.startNote) {
      append(body, [
        this.x(
          "p",
          { class: "note note--warn" },
          this.i("alert"),
          this.x("span", { text: tm(this.startNote) }),
        ),
      ]);
    }
    append(body, [
      this.x("h2", { text: t("startHeading") }),
      this.x("p", { class: "muted", text: t("startLead") }),
      this.x(
        "div",
        { class: "choice" },
        this.x(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            "data-p": "claude",
            "aria-disabled": "true",
            "aria-describedby": "claude-why",
          },
          this.i("sparkle"),
          this.x(
            "span",
            {},
            t("startClaude"),
            this.x("small", { id: "claude-why", text: t("startClaudeSoon") }),
          ),
        ),
        this.x(
          "button",
          { class: "btn btn--ghost", type: "button", "data-p": "manual" },
          this.i("pointer"),
          this.x(
            "span",
            {},
            t("startManual"),
            this.x("small", { text: t("startManualSmall") }),
          ),
        ),
      ),
    ]);
    const foot = this.x(
      "div",
      { class: "p-foot" },
      this.x(
        "p",
        { class: "privacy" },
        this.i("lock"),
        this.x("span", { text: t("startPrivacy") }),
      ),
    );
    return [body, foot];
  }

  private viewPick(): HTMLElement[] {
    const m = this.model;
    const target = this.cursor;
    const kept = m.keptCards();
    const body = this.x("div", { class: "p-body" });
    append(body, [
      this.x("p", { class: "muted", text: t(m.card ? "pickLeadCard" : "pickLeadNoCard") }),
      this.cursorBox(target),
      this.rolesList(true),
    ]);
    if (m.card && (m.fields.title || m.fields.text) && !m.fields.link) {
      append(body, [
        this.note("warn", "alert", [this.x("span", { text: t("noteLinkMissing") })]),
      ]);
    }
    if (this.source === "existing" && this.existing) {
      append(body, [
        this.note("ok", "check", [
          this.x(
            "span",
            {},
            t("noteExisting", this.existing.matching, this.existing.total),
            " ",
            this.x("button", {
              class: "linkbtn",
              type: "button",
              "data-p": "reset",
              text: t("startOver"),
            }),
          ),
        ]),
      ]);
    }
    append(body, [this.toast]);
    const ready = m.ready();
    const foot = this.x(
      "div",
      { class: "p-foot" },
      this.x("button", {
        class: "btn btn--primary",
        type: "button",
        "data-p": "preview",
        disabled: !ready,
        "aria-describedby": "pv-why",
        text: ready
          ? t("previewBtnCount", Math.min(PREVIEW_COUNT, kept.length), kept.length)
          : t("previewBtn"),
      }),
      this.x("span", { class: "sr-only", id: "pv-why", text: ready ? "" : t("previewWhy") }),
    );
    return [body, foot];
  }

  private cursorBox(target: Element | null): HTMLElement {
    const label = target ? t("cursorAriaWith", this.model.describe(target)) : t("cursorAria");
    return this.x(
      "div",
      {
        class: "cursorbox",
        id: "cursorbox",
        tabindex: 0,
        role: "group",
        "aria-roledescription": t("cursorRoleDesc"),
        "aria-label": label,
        "aria-describedby": "cb-keys",
      },
      this.cursorRow(target),
      this.x(
        "div",
        { class: "cursorbox__keys", id: "cb-keys" },
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "up", tabindex: -1 },
          this.i("up"),
          t("navWider"),
        ),
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "down", tabindex: -1 },
          this.i("down"),
          t("navNarrower"),
        ),
        this.x("button", {
          class: "kb",
          type: "button",
          "data-nav": "open",
          tabindex: -1,
          text: t("navOpen"),
        }),
      ),
    );
  }

  private cursorRow(target: Element | null): HTMLElement {
    return this.x(
      "div",
      { class: "cursorbox__row" },
      this.i("pointer"),
      this.x("code", { text: target ? this.model.describe(target) : t("cursorEmpty") }),
      target
        ? this.x("span", {
            class: "cursorbox__cnt",
            text: t("cursorSimilar", this.model.similarCount(target)),
          })
        : null,
    );
  }

  private rolesList(editable: boolean): HTMLElement {
    const m = this.model;
    const kept = m.keptCards();
    const all = m.allCards();
    const list = this.x("ul", { class: "roles", "aria-label": t("rolesAria") });
    for (const role of ROLES) {
      if (role === "cut") continue;
      let filled = false;
      const value = this.x("span", { class: "r-val" });
      if (role === "card" && m.card) {
        filled = true;
        const excluded = all.length - kept.length;
        append(value, [
          this.x("code", { text: m.card }),
          " · ",
          this.x("span", { class: "ok", text: t("roleValueCards", kept.length) }),
          excluded ? ` · ${t("roleValueExcluded", excluded)}` : "",
        ]);
      } else if (role !== "card" && m.fields[role]) {
        filled = true;
        const cov = m.coverage(role);
        value.className = `r-val ${cov && cov.n === cov.of ? "ok" : "warn"}`;
        append(value, [
          this.x("code", { text: m.fields[role]?.selector ?? "" }),
          cov ? ` · ${cov.n}/${cov.of}` : "",
        ]);
      } else if (role === "card") {
        value.textContent = t("roleFirst");
      } else if ((role === "title" || role === "text") && !m.fields.title && !m.fields.text) {
        value.textContent = t("roleTitleOrText");
      } else {
        value.textContent = t(role === "link" ? "roleRecommended" : "roleOptional");
      }
      list.append(
        this.roleRow(
          role,
          filled,
          value,
          filled && editable
            ? this.x(
                "button",
                {
                  class: "rm",
                  type: "button",
                  "data-clear": role,
                  "aria-label": t("clearRole", t(ROLE_NAME_KEYS[role])),
                },
                this.i("close"),
              )
            : this.x("span"),
        ),
      );
    }
    const parts: Child[] = [];
    const add = (child: Child): void => {
      if (parts.length > 0) parts.push(" · ");
      parts.push(child);
    };
    for (const ex of m.excludes) add(t("cutsCardsWith", ex.label));
    if (m.notThis.size)
      add(this.x("span", { class: "warn", text: t("cutsUnwritable", m.notThis.size) }));
    if (m.strip.length) add(this.x("code", { text: m.strip.join(", ") }));
    if (m.outside.length) add(t("cutsOutside", m.outside.length));
    const cutValue = this.x("span", { class: "r-val" });
    if (parts.length) append(cutValue, parts);
    else cutValue.textContent = t("cutsEmpty");
    list.append(
      this.roleRow(
        "cut",
        parts.length > 0,
        cutValue,
        parts.length && editable
          ? this.x(
              "button",
              {
                class: "rm",
                type: "button",
                "data-clear": "cut",
                "aria-label": t("clearCuts"),
              },
              this.i("close"),
            )
          : this.x("span"),
        t("cutsLabel"),
      ),
    );
    return list;
  }

  private roleRow(
    role: Role,
    filled: boolean,
    value: HTMLElement,
    action: HTMLElement,
    name?: string,
  ): HTMLElement {
    const badge = this.x("span", {
      class: "badge",
      "aria-hidden": "true",
      text: t(ROLE_LETTER_KEYS[role]),
    });
    badge.style.setProperty("--c", ROLE_COLORS[role]);
    return this.x(
      "li",
      { class: filled ? "" : "is-empty" },
      badge,
      this.x("span", { class: "r-name" }, name ?? t(ROLE_NAME_KEYS[role]), value),
      action,
    );
  }

  private note(
    kind: "warn" | "ok" | "info",
    iconName: IconName,
    children: Child[],
  ): HTMLElement {
    return this.x("p", { class: `note note--${kind}` }, this.i(iconName), ...children);
  }

  private viewSaved(): HTMLElement[] {
    const host = hostOf(this.init.target.url);
    return [
      this.x(
        "div",
        { class: "p-body", role: "status" },
        this.x("div", { class: "done-icon", "aria-hidden": "true" }, this.i("check")),
        this.x("h2", { text: t("savedHeading") }),
        this.x("p", { class: "muted", text: t("savedBody", this.savedCount, host) }),
      ),
      this.x(
        "div",
        { class: "p-foot" },
        this.x("button", {
          class: "btn btn--primary",
          type: "button",
          "data-p": "to-options",
          text: t("savedToOptions"),
        }),
        this.x("button", {
          class: "btn btn--ghost",
          type: "button",
          "data-p": "close",
          text: t("savedStay"),
        }),
      ),
    ];
  }

  private viewConfirmExit(): HTMLElement[] {
    return [
      this.x(
        "div",
        {
          class: "p-body",
          role: "alertdialog",
          "aria-labelledby": "ce-h",
          "aria-describedby": "ce-d",
        },
        this.x("h2", { id: "ce-h", text: t("exitHeading") }),
        this.x("p", { class: "muted", id: "ce-d", text: t("exitBody") }),
      ),
      this.x(
        "div",
        { class: "p-foot" },
        this.x("button", {
          class: "btn btn--primary",
          type: "button",
          "data-p": "resume",
          text: t("exitResume"),
        }),
        this.x("button", {
          class: "btn btn--ghost",
          type: "button",
          "data-p": "close",
          text: t("exitLeave"),
        }),
      ),
    ];
  }

  // --- preview drawer -------------------------------------------------

  /** The rule as it stands, for the preview and the save. */
  currentRule(): SiteRuleInput {
    const form = this.form ?? this.defaultForm();
    const rule = this.init.rule;
    const now = this.env.now();
    const pagination: Pagination =
      form.pagination === "none"
        ? { type: "none" }
        : form.pagination === "scroll"
          ? { type: "scroll", maxPages: form.maxPages }
          : form.pagination === "load-more" && this.hints.loadMore
            ? {
                type: "load-more",
                selector: this.hints.loadMore.selector,
                maxPages: form.maxPages,
              }
            : form.pagination === "next-page" && this.hints.nextPage
              ? {
                  type: "next-page",
                  selector: this.hints.nextPage.selector,
                  maxPages: form.maxPages,
                }
              : { type: "none" };
    const collect: SiteRuleInput["collect"] = { method: form.method };
    if (rule?.collect.rssUrl) collect.rssUrl = rule.collect.rssUrl;
    if (this.request)
      collect.request = { match: this.request.pattern, format: this.request.format };
    else if (rule?.collect.request) collect.request = rule.collect.request;
    return this.model.toRule({
      url: this.init.target.url,
      pattern: this.init.target.pattern,
      name: form.name.trim() || hostOf(this.init.target.url),
      ...(rule ? { id: rule.id } : {}),
      collect,
      pagination,
      minItems: form.minItems,
      createdAt: rule?.createdAt ?? now,
      now,
    });
  }

  previewItems(): GenericItem[] {
    const parsed = SiteRuleSchema.safeParse(this.currentRule());
    if (!parsed.success) return [];
    return extractItems(this.env.doc, parsed.data, { pageUrl: this.env.win.location.href })
      .items;
  }

  private defaultForm(): DrawerForm {
    const kept = this.model.keptCards().length;
    const rule = this.init.rule;
    const title = this.env.doc.title.replace(/\s+/g, " ").trim();
    const hasMore = rule
      ? rule.pagination.type
      : this.hints.loadMore
        ? "load-more"
        : this.hints.nextPage
          ? "next-page"
          : "none";
    return {
      name: (rule?.name ?? (title || hostOf(this.init.target.url))).slice(0, 80),
      pagination: hasMore,
      maxPages: rule && rule.pagination.type !== "none" ? rule.pagination.maxPages : 3,
      minItems:
        rule?.health.minItems ??
        Math.max(1, Math.min(kept, Math.max(3, Math.round(kept * 0.4)))),
      method: rule?.collect.method ?? "auto",
    };
  }

  private openPreview(): void {
    if (!this.model.ready()) return;
    this.hints = paginationHints(this.env.doc, (el) => this.isPage(el), this.model.allCards());
    this.form = this.defaultForm();
    this.mode = "preview";
    this.minimized = false;
    this.closePop(false);
    // Focus on the first item (design); the back button when nothing came out.
    this.render();
    (this.q(".drawer .post") ?? this.q(".drawer [data-p='back']"))?.focus();
    void this.runProbe();
  }

  private async runProbe(): Promise<void> {
    this.probe = "checking";
    this.refreshMethodNote();
    try {
      const answer = (await this.env.send({
        kind: "site-probe",
        rule: { ...this.currentRule(), collect: { method: "static" } },
      })) as SiteProbeAnswer | undefined;
      this.probe = answer ?? { ok: false, count: 0 };
    } catch {
      this.probe = { ok: false, count: 0 };
    }
    this.refreshMethodNote();
  }

  private renderDrawer(): void {
    const items = this.previewItems();
    const kept = this.model.keptCards();
    const show = items.slice(0, PREVIEW_COUNT);
    const form = this.form ?? this.defaultForm();
    this.form = form;
    const fields = this.model.fields;
    const missing = (key: "author" | "image" | "time"): number =>
      fields[key]
        ? items.filter((item) => !(key === "time" ? item.publishedAt : item[key])).length
        : 0;
    const gaps = (
      [
        ["author", "missingAuthor"],
        ["image", "missingImage"],
        ["time", "missingTime"],
      ] as const
    )
      .map(([key, label]) => [missing(key), label] as const)
      .filter(([n]) => n > 0);
    const excluded = this.model.allCards().length - kept.length;
    const summary = this.x(
      "p",
      { class: "d-sum" },
      this.x("b", { text: t("drawerItems", items.length) }),
      ` · ${t("drawerShown", show.length)}`,
    );
    if (excluded) summary.append(` · ${t("drawerExcluded", excluded)}`);
    if (gaps.length)
      summary.append(
        ` · ${gaps.map(([n, label]) => t("drawerMissing", n, t(label))).join(", ")}`,
      );

    const feed = this.x("div", {
      role: "feed",
      "aria-label": t("drawerFeedAria", show.length),
    });
    show.forEach((item, index) => feed.append(this.postCard(item, index, items.length)));
    const body = this.x("div", { class: "d-body" }, feed);
    if (items.length === 0) {
      body.append(this.x("p", { class: "d-zero note note--warn", text: t("drawerZero") }));
    }
    if (items.length > PREVIEW_COUNT) {
      body.append(
        this.x("p", { class: "d-more", text: t("drawerMore", items.length - PREVIEW_COUNT) }),
      );
    }
    body.append(this.drawerForm(form, items.length));

    this.drawer.replaceChildren(
      this.x(
        "header",
        { class: "p-head" },
        this.x("span", { class: "p-logo", "aria-hidden": "true", text: "NMC" }),
        this.x(
          "div",
          { class: "p-titles" },
          this.x("div", { class: "p-brand", id: "d-h", text: t("drawerTitle") }),
          this.x("div", { class: "p-site", text: this.init.target.pattern }),
        ),
        this.x(
          "button",
          { class: "hbtn", type: "button", "data-p": "back", "aria-label": t("drawerBack") },
          this.i("left"),
        ),
      ),
      summary,
      body,
      this.x(
        "footer",
        { class: "d-foot" },
        this.x("button", {
          class: "btn btn--ghost",
          type: "button",
          "data-p": "back",
          text: t("drawerBack"),
        }),
        this.x("button", {
          class: "btn btn--primary",
          type: "button",
          "data-p": "save",
          disabled: items.length === 0,
          text: t("save"),
        }),
      ),
    );
    this.drawer.hidden = false;
    this.refreshMethodNote();
  }

  private postCard(item: GenericItem, index: number, total: number): HTMLElement {
    const host = hostOf(this.init.target.url);
    const name = item.author ?? this.form?.name ?? host;
    const when = item.publishedAt
      ? relativeTime(item.publishedAt, Date.parse(this.env.now()), t("langCode"))
      : "";
    const head = this.x(
      "div",
      { class: "post__head" },
      this.x("span", { class: "post__name", text: name }),
      this.x("span", { class: "post__handle", text: item.domain }),
    );
    if (when && item.publishedAt) {
      head.append(
        this.x("span", { class: "post__dot", "aria-hidden": "true", text: "·" }),
        this.x("time", { class: "post__time", datetime: item.publishedAt, text: when }),
      );
    }
    const content = this.x("div", { class: "post__content" }, head);
    content.style.setProperty("min-width", "0");
    if (item.title) content.append(this.x("p", { class: "post__title", text: item.title }));
    if (item.text) content.append(this.x("p", { class: "post__text", text: item.text }));
    if (!item.title && !item.text)
      content.append(this.x("p", { class: "post__missing", text: t("postNoText") }));
    if (item.image) {
      content.append(
        this.x(
          "div",
          { class: "media" },
          this.x("img", {
            src: item.image.url,
            alt: "",
            loading: "lazy",
            referrerpolicy: "no-referrer",
          }),
        ),
      );
    }
    const fieldsHaveLink = Boolean(this.model.fields.link);
    content.append(
      this.x(
        "div",
        { class: "post__foot" },
        fieldsHaveLink || item.url !== this.init.target.url
          ? this.x(
              "a",
              { class: "open", href: item.url, target: "_blank", rel: "noopener noreferrer" },
              t("openOnSite"),
              this.i("external"),
              this.x("span", { class: "sr-only", text: ` ${t("newTab")}` }),
            )
          : this.x("span", { class: "post__missing", text: t("noLink") }),
      ),
    );
    const avatar = this.x("span", {
      class: "avatar",
      "aria-hidden": "true",
      text: (name[0] ?? "?").toLocaleUpperCase(t("langCode")),
    });
    return this.x(
      "article",
      {
        class: "post",
        tabindex: 0,
        "aria-posinset": index + 1,
        "aria-setsize": total,
        "aria-label": item.title ?? (item.text ?? "").slice(0, 60),
      },
      this.x("div", { class: "post__grid" }, avatar, content),
    );
  }

  private drawerForm(form: DrawerForm, count: number): HTMLElement {
    const hasRss = Boolean(this.init.rule?.collect.rssUrl);
    const pageOptions: [Pagination["type"], string][] = [];
    if (this.hints.loadMore)
      pageOptions.push(["load-more", t("moreLoad", this.hints.loadMore.label)]);
    pageOptions.push(["scroll", t("moreScroll")]);
    if (this.hints.nextPage) pageOptions.push(["next-page", t("moreNext")]);
    pageOptions.push(["none", t("moreNone")]);
    const select = (
      id: string,
      value: string,
      options: [string, string][],
      describedBy?: string,
    ): HTMLElement => {
      const el = this.x("select", { id, "aria-describedby": describedBy });
      for (const [v, label] of options) {
        const option = this.x("option", { value: v, text: label }) as HTMLOptionElement;
        option.selected = v === value;
        el.append(option);
      }
      return el;
    };
    const methods: [CollectMethod, string][] = [["auto", t("methodAuto")]];
    if (hasRss) methods.push(["rss", t("methodRss")]);
    methods.push(["static", t("methodStatic")]);
    if (this.request || this.init.rule?.collect.request)
      methods.push(["request", t("methodRequest")]);
    methods.push(["page", t("methodPage")]);

    const moreHelp =
      form.pagination === "load-more" && this.hints.loadMore
        ? t("moreHelpButton", this.hints.loadMore.selector)
        : form.pagination === "none"
          ? t("moreHelpNone")
          : t("moreHelp");

    const detect = this.x("div", { id: "f-detect" });
    this.fillDetect(detect);

    return this.x(
      "form",
      { class: "d-form", id: "d-form", novalidate: true },
      this.x("h3", { text: t("formRule") }),
      this.x(
        "div",
        { class: "f" },
        this.x("label", { for: "f-name", text: t("formName") }),
        this.x("input", { id: "f-name", value: form.name, autocomplete: "off", maxlength: 80 }),
      ),
      this.x(
        "div",
        { class: "f" },
        this.x("span", { class: "lbl", text: t("formAddress") }),
        this.x(
          "div",
          { class: "readonly" },
          this.init.target.url,
          this.x("br"),
          this.init.target.pattern,
        ),
      ),
      this.x(
        "div",
        { class: "f" },
        this.x("label", { for: "f-page", text: t("formMore") }),
        select("f-page", form.pagination, pageOptions, "f-page-h"),
        this.x("p", { class: "muted", id: "f-page-h", text: moreHelp }),
        detect,
      ),
      this.x(
        "div",
        { class: "f" },
        this.x("label", { for: "f-max", text: t("formMaxPages") }),
        this.x(
          "div",
          { class: "row" },
          this.x("input", {
            id: "f-max",
            type: "number",
            min: 1,
            max: 10,
            value: form.maxPages,
            inputmode: "numeric",
          }),
          this.x("span", { class: "muted", text: t("formMaxApprox", count * form.maxPages) }),
        ),
      ),
      this.x(
        "div",
        { class: "f" },
        this.x("label", { for: "f-min", text: t("formMinItems") }),
        this.x(
          "div",
          { class: "row" },
          this.x("input", {
            id: "f-min",
            type: "number",
            min: 1,
            max: 500,
            value: form.minItems,
            inputmode: "numeric",
            "aria-describedby": "f-min-h",
          }),
          this.x("span", { class: "muted", text: t("formItemsUnit") }),
        ),
        this.x("p", { class: "muted", id: "f-min-h", text: t("formMinHelp", count) }),
      ),
      this.x(
        "div",
        { class: "f" },
        this.x("label", { for: "f-method", text: t("formMethod") }),
        select("f-method", form.method, methods, "f-method-note"),
        this.x("div", { id: "f-method-note", "aria-live": "polite" }),
      ),
    );
  }

  private fillDetect(container: HTMLElement): void {
    container.replaceChildren();
    if (this.detectNote) {
      const ok = this.request?.format === "html";
      container.append(
        this.note(ok ? "ok" : "info", ok ? "check" : "question", [
          this.x("span", { text: tm(this.detectNote) }),
        ]),
      );
    }
    if (this.hints.loadMore && !this.request) {
      container.append(
        this.x("button", {
          class: "btn btn--ghost btn--inline",
          type: "button",
          "data-p": "detect",
          disabled: this.detecting,
          text: this.detecting ? t("detectRunning", this.hints.loadMore.label) : t("detectBtn"),
        }),
      );
    }
  }

  private refreshMethodNote(): void {
    const box = this.q("#f-method-note");
    if (!box) return;
    const method = this.form?.method ?? "auto";
    let note: HTMLElement;
    if (method === "page") {
      note = this.note("info", "question", [this.x("span", { text: t("methodNotePage") })]);
    } else if (method === "request") {
      note = this.note("info", "question", [this.x("span", { text: t("methodNoteRequest") })]);
    } else if (method === "rss") {
      note = this.note("ok", "check", [this.x("span", { text: t("methodNoteRss") })]);
    } else if (this.probe === "checking" || this.probe === null) {
      note = this.note("info", "question", [this.x("span", { text: t("methodNoteChecking") })]);
    } else if (this.probe.count > 0) {
      note = this.note("ok", "check", [this.x("span", { text: t("methodNoteStaticOk") })]);
    } else {
      note = this.note("warn", "alert", [this.x("span", { text: t("methodNoteStaticNo") })]);
    }
    box.replaceChildren(note);
  }

  private readForm(): void {
    if (!this.form) return;
    const value = (id: string): string => this.q<HTMLInputElement>(`#${id}`)?.value ?? "";
    const num = (id: string, fallback: number, max: number): number => {
      const n = Number.parseInt(value(id), 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
    };
    const page = value("f-page") as Pagination["type"];
    const method = value("f-method") as CollectMethod;
    this.form = {
      name: value("f-name"),
      pagination: ["none", "scroll", "load-more", "next-page"].includes(page)
        ? page
        : this.form.pagination,
      maxPages: num("f-max", this.form.maxPages, 10),
      minItems: num("f-min", this.form.minItems, 500),
      method: ["auto", "rss", "static", "request", "page"].includes(method)
        ? method
        : this.form.method,
    };
  }

  /** Presses the page's own "load more" once and watches which request it makes. */
  private async detectRequest(): Promise<void> {
    const button = this.hints.loadMore;
    if (!button || this.detecting) return;
    this.detecting = true;
    this.detectNote = null;
    const detect = this.q("#f-detect");
    if (detect) this.fillDetect(detect);
    this.seen = [];
    try {
      await this.env.send({ kind: "site-picker-hook" });
      const arm: SiteHookArmMessage = {
        source: PAGE_MESSAGE_SOURCE,
        kind: "site-hook-arm",
        patterns: [],
        detect: true,
      };
      this.env.win.postMessage(arm, this.env.win.location.origin);
      const el = this.env.doc.querySelector(button.selector);
      if (
        el instanceof
        (this.env.win as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement
      ) {
        this.passThrough = true;
        try {
          el.click();
        } finally {
          this.passThrough = false;
        }
      }
      await new Promise((resolve) => this.env.win.setTimeout(resolve, DETECT_WAIT_MS));
    } catch {
      // The hook could not be injected: reported as "no request seen".
    }
    const disarm: SiteHookArmMessage = {
      source: PAGE_MESSAGE_SOURCE,
      kind: "site-hook-arm",
      patterns: [],
      detect: false,
    };
    this.env.win.postMessage(disarm, this.env.win.location.origin);
    const parser = new (this.env.win as unknown as { DOMParser: typeof DOMParser }).DOMParser();
    this.request = pickRequestCandidate(
      this.seen,
      this.env.win.location.origin,
      this.model.card,
      (html) => parser.parseFromString(html, "text/html"),
    );
    this.detectNote = !this.request
      ? { key: "detectNone" }
      : this.request.format === "json"
        ? { key: "detectFoundJson", args: [this.request.pattern] }
        : { key: "detectFound", args: [this.request.pattern, this.request.cards] };
    this.detecting = false;
    if (this.mode === "preview") this.render();
    this.announce(this.detectNote);
  }

  private seen: SeenResponse[] = [];

  private onWindowMessage(event: MessageEvent): void {
    if (event.source !== this.env.win || !this.detecting) return;
    if (!isSiteHookResponseMessage(event.data)) return;
    const { url, contentType, bodyText } = event.data;
    if (this.seen.length < 50) this.seen.push({ url, contentType, bodyText });
  }

  private async save(): Promise<void> {
    this.readForm();
    const rule = this.currentRule();
    const found = this.previewItems().length;
    const saveBtn = this.q<HTMLButtonElement>("[data-p='save']");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = t("saving");
    }
    let answer: SitePickerSaveAnswer | undefined;
    try {
      answer = (await this.env.send({ kind: "site-picker-save", rule, foundCount: found })) as
        SitePickerSaveAnswer | undefined;
    } catch (error) {
      answer = { ok: false, message: String(error) };
    }
    if (!answer?.ok) {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = t("save");
      }
      this.announce({ key: "saveFailed", args: [answer?.message ?? "?"] });
      const sum = this.drawer.querySelector(".d-sum");
      sum?.after(
        this.x("p", {
          class: "d-zero note note--warn",
          role: "alert",
          text: t("saveFailed", answer?.message ?? "?"),
        }),
      );
      return;
    }
    this.savedCount = found;
    this.model.dirty = false;
    this.setMode("saved", "[data-p='to-options']");
    this.announce({ key: "annSaved" });
  }

  // --- the highlight layer -------------------------------------------

  repaint(): void {
    if (this.raf) this.env.win.cancelAnimationFrame(this.raf);
    this.raf = this.env.win.requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private box(el: Element, cls: string, color: string, tag?: HTMLElement): void {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > this.env.win.innerHeight || r.width === 0) return;
    const box = this.x("div", { class: `box ${cls}` });
    box.style.setProperty("--c", color);
    box.style.setProperty("left", `${r.left - 2}px`);
    box.style.setProperty("top", `${r.top - 2}px`);
    box.style.setProperty("width", `${r.width + 4}px`);
    box.style.setProperty("height", `${r.height + 4}px`);
    if (tag) box.append(tag);
    this.layer.append(box);
  }

  private tag(color: string, inside: boolean, ...children: Child[]): HTMLElement {
    const tag = this.x("span", { class: inside ? "tag tag--in" : "tag" }, ...children);
    tag.style.setProperty("--c", color);
    return tag;
  }

  paint(): void {
    this.layer.replaceChildren();
    const m = this.model;
    if (this.mode === "pick" || this.mode === "preview" || this.mode === "confirm-exit") {
      const kept = m.keptCards();
      for (const card of m.allCards()) {
        if (m.notThis.has(card)) {
          this.box(
            card,
            "box--not",
            "#536471",
            this.tag("#3f4f5e", true, this.i("close"), t("layerNotThis")),
          );
        } else {
          const ex = m.exclusionOf(card);
          if (ex)
            this.box(
              card,
              "box--veil",
              ROLE_COLORS.cut,
              this.tag(
                ROLE_COLORS.cut,
                true,
                this.x("b", { text: "⊘" }),
                ` ${t("layerCutWhy", ex.label)}`,
              ),
            );
        }
      }
      kept.forEach((card, index) => {
        const first = index === 0;
        this.box(
          card,
          first ? "" : "box--match",
          ROLE_COLORS.card,
          first
            ? this.tag(
                ROLE_COLORS.card,
                false,
                this.x("b", { text: t("letterCard") }),
                ` ${t("layerFirstCard", kept.length)}`,
              )
            : this.tag(ROLE_COLORS.card, false, this.x("b", { text: String(index + 1) })),
        );
        for (const key of FIELD_ROLES) {
          const field = m.fieldEl(card, key);
          if (!field || field === card) continue;
          this.box(
            field,
            "box--field",
            ROLE_COLORS[key],
            this.tag(
              ROLE_COLORS[key],
              true,
              this.x("b", { text: t(ROLE_LETTER_KEYS[key]) }),
              first ? ` ${t(ROLE_NAME_KEYS[key])}` : "",
            ),
          );
        }
        for (const selector of m.strip) {
          for (const part of queryAll(card, selector)) {
            this.box(
              part,
              "box--veil",
              ROLE_COLORS.cut,
              first
                ? this.tag(
                    ROLE_COLORS.cut,
                    true,
                    this.x("b", { text: "⊘" }),
                    ` ${t("roleCut")}`,
                  )
                : undefined,
            );
          }
        }
      });
      for (const el of m.outside) {
        this.box(
          el,
          "box--veil",
          ROLE_COLORS.cut,
          this.tag(ROLE_COLORS.cut, true, this.x("b", { text: "⊘" }), ` ${t("roleCut")}`),
        );
      }
    }
    if (this.mode === "pick") {
      const target = this.popTarget ?? this.cursor ?? this.hover;
      if (target && this.isPage(target)) {
        const count = m.similarCount(target);
        const strong = target === this.cursor || target === this.popTarget;
        this.box(
          target,
          strong ? "box--cursor" : "box--hover",
          ROLE_COLORS.card,
          this.tag(
            "#0f1419",
            false,
            this.x("code", { text: m.describe(target) }),
            count > 1 ? ` · ${count}` : "",
          ),
        );
      }
    }
  }

  // --- role window ----------------------------------------------------

  openPop(el: Element, x: number, y: number): void {
    this.popTarget = el;
    this.cursor = el;
    this.popAnchor = { x, y };
    this.popMessage = [];
    this.renderPop();
    const pressed =
      this.pop.querySelector<HTMLElement>(".rbtn[aria-pressed='true']") ??
      this.pop.querySelector<HTMLElement>(".rbtn");
    pressed?.focus();
    this.announce({
      key: "annPopOpen",
      args: [this.model.describe(el), this.model.similarCount(el)],
    });
    this.repaint();
  }

  private renderPop(): void {
    const el = this.popTarget;
    if (!el) {
      this.pop.hidden = true;
      return;
    }
    const m = this.model;
    const current = m.assignedRole(el);
    const card = m.cardOf(el);
    const notThisOk = Boolean(card) && m.keptCards().length > 1;
    const roles = this.x("div", {
      class: "pop__roles",
      role: "group",
      "aria-label": t("popRoles"),
    });
    ROLES.forEach((role, index) => {
      const help = ROLE_HELP_KEYS[role];
      const badge = this.x("span", {
        class: "badge",
        "aria-hidden": "true",
        text: t(ROLE_LETTER_KEYS[role]),
      });
      badge.style.setProperty("--c", ROLE_COLORS[role]);
      const button = this.x(
        "button",
        {
          class: role === "cut" ? "rbtn rbtn--cut" : "rbtn",
          type: "button",
          "data-role": role,
          "aria-pressed": String(current === role),
          title: help ? t(help) : undefined,
        },
        badge,
        t(ROLE_NAME_KEYS[role]),
        this.x("kbd", { "aria-hidden": "true", text: String(index + 1) }),
      );
      button.style.setProperty("--c", ROLE_COLORS[role]);
      roles.append(button);
    });
    this.pop.replaceChildren(
      this.x("h2", { class: "sr-only", id: "pop-h", text: t("popHeading") }),
      this.x(
        "div",
        { class: "pop__head" },
        this.x("code", { text: m.describe(el) }),
        this.x("span", { text: t("cursorSimilar", m.similarCount(el)) }),
      ),
      this.x(
        "div",
        { class: "pop__nav", role: "group", "aria-label": t("popNavGroup") },
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "up" },
          this.i("up"),
          t("popWide"),
        ),
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "down" },
          this.i("down"),
          t("popNarrow"),
        ),
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "prev", "aria-label": t("navPrev") },
          this.i("left"),
        ),
        this.x(
          "button",
          { class: "kb", type: "button", "data-nav": "next", "aria-label": t("navNext") },
          this.i("right"),
        ),
      ),
      roles,
    );
    if (notThisOk || current) {
      this.pop.append(
        this.x(
          "div",
          { class: "pop__extra" },
          notThisOk
            ? this.x(
                "button",
                { class: "btn btn--ghost btn--inline", type: "button", "data-pop": "notthis" },
                this.i("close"),
                t("popNotThis"),
              )
            : null,
          current
            ? this.x("button", {
                class: "btn btn--ghost btn--inline",
                type: "button",
                "data-pop": "clear",
                text: t("popClear"),
              })
            : null,
        ),
      );
    }
    if (this.popMessage.length) {
      this.pop.append(
        this.x("p", {
          class: "pop__msg",
          role: "alert",
          text: this.popMessage.map(tm).join(" "),
        }),
      );
    }
    this.pop.hidden = false;
    const w = 288;
    const height = this.pop.offsetHeight;
    const { innerWidth, innerHeight } = this.env.win;
    const left = Math.min(Math.max(8, this.popAnchor.x + 12), innerWidth - w - 8);
    let top = this.popAnchor.y + 12;
    if (top + height > innerHeight - 8) top = Math.max(8, this.popAnchor.y - height - 12);
    this.pop.style.setProperty("left", `${left}px`);
    this.pop.style.setProperty("top", `${top}px`);
  }

  closePop(returnFocus = true): void {
    this.popTarget = null;
    this.pop.hidden = true;
    this.repaint();
    if (returnFocus) this.q("#cursorbox")?.focus();
  }

  choose(role: Role): void {
    const el = this.popTarget;
    if (!el) return;
    const result = this.model.assign(role, el);
    if (!result.ok) {
      this.popMessage = result.msg;
      this.renderPop();
      this.pop.querySelector<HTMLElement>(`[data-role="${role}"]`)?.focus();
      this.announce(result.msg.map(tm).join(" "));
      return;
    }
    this.closePop(false);
    this.render("#cursorbox");
    this.say(
      result.msg,
      result.undo
        ? () => {
            result.undo?.();
            this.render("#cursorbox");
          }
        : null,
    );
  }

  // --- moving the cursor ---------------------------------------------

  move(dir: "up" | "down" | "prev" | "next"): void {
    let target = this.popTarget ?? this.cursor;
    if (!target) {
      target =
        this.model.keptCards()[0] ??
        this.firstRepeating() ??
        firstPageElement(this.env.doc, (el) => this.isPage(el));
      if (!target) return;
    } else {
      let next: Element | null = null;
      if (dir === "up") next = target.parentElement;
      if (dir === "down") next = target.firstElementChild;
      if (dir === "prev") next = target.previousElementSibling;
      if (dir === "next") next = target.nextElementSibling;
      if (next === this.host) next = dir === "next" ? null : next.previousElementSibling;
      if (!this.isPage(next)) {
        this.announce({
          key: dir === "up" ? "annNoWider" : dir === "down" ? "annNoNarrower" : "annNoSibling",
        });
        return;
      }
      target = next;
    }
    const scroll = (
      target as Element & { scrollIntoView?: (arg: ScrollIntoViewOptions) => void }
    ).scrollIntoView;
    if (typeof scroll === "function") scroll.call(target, { block: "nearest" });
    if (this.popTarget) {
      this.popTarget = target;
      this.cursor = target;
      const r = target.getBoundingClientRect();
      this.popAnchor = { x: r.left, y: Math.min(r.bottom, this.env.win.innerHeight - 40) };
      this.renderPop();
      this.pop.querySelector<HTMLElement>(`[data-nav="${dir}"]`)?.focus();
    } else {
      this.cursor = target;
      this.refreshCursorBox();
    }
    this.announce({
      key: "annCursor",
      args: [this.model.describe(target), this.model.similarCount(target)],
    });
    this.repaint();
  }

  /** The first card of the first repeating block on the page (for the first ↓). */
  private firstRepeating(): Element | null {
    const { doc } = this.env;
    for (const el of queryAll(doc, "article, li, [class]")) {
      if (!this.isPage(el)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      const alike = Array.from(parent.children).filter(
        (s) => s.tagName === el.tagName && s.className === (el as HTMLElement).className,
      );
      if (alike.length >= 3) return el;
    }
    return null;
  }

  private refreshCursorBox(): void {
    const box = this.q("#cursorbox");
    if (!box) return;
    box.querySelector(".cursorbox__row")?.replaceWith(this.cursorRow(this.cursor));
    box.setAttribute(
      "aria-label",
      this.cursor ? t("cursorAriaWith", this.model.describe(this.cursor)) : t("cursorAria"),
    );
  }

  private openPopAtCursor(): void {
    const el = this.cursor;
    if (!el) {
      this.announce({ key: "annMoveFirst" });
      return;
    }
    const r = el.getBoundingClientRect();
    this.openPop(el, r.left, Math.min(r.bottom, this.env.win.innerHeight - 40));
  }

  // --- modes ----------------------------------------------------------

  setMode(mode: PickerMode, focus?: string): void {
    if (this.popTarget) this.closePop(false);
    this.mode = mode;
    this.minimized = false;
    this.render(focus);
  }

  /** Esc / ✕: asks first when there is an unsaved selection. */
  exit(force = false): void {
    if (!force && this.model.dirty && this.mode !== "saved" && this.mode !== "confirm-exit") {
      this.prevMode = this.mode;
      this.setMode("confirm-exit", "[data-p='resume']");
      return;
    }
    this.destroy();
  }

  // --- events ---------------------------------------------------------

  private onShadowClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target?.closest) return;
    const p = target.closest<HTMLElement>("[data-p]");
    if (p) {
      switch (p.dataset["p"]) {
        case "claude":
          // Coming with the desktop path (separate job); the button explains why.
          this.announce(t("startClaudeSoon"));
          return;
        case "manual":
          this.model.reset();
          this.source = "manual";
          this.setMode("pick", "#cursorbox");
          this.announce({ key: "annPickerOpen" });
          return;
        case "reset":
          this.model.reset();
          this.source = "manual";
          this.existing = null;
          this.setMode("pick", "#cursorbox");
          return;
        case "preview":
          this.openPreview();
          return;
        case "back":
          this.readForm();
          this.mode = "pick";
          this.render("#cursorbox");
          return;
        case "save":
          void this.save();
          return;
        case "detect":
          this.readForm();
          void this.detectRequest();
          return;
        case "resume":
          this.setMode(this.prevMode, "#cursorbox");
          return;
        case "undo": {
          const undo = this.toastUndo;
          this.toastUndo = null;
          undo?.();
          return;
        }
        case "close":
          this.destroy();
          return;
        case "to-options":
          void this.env.send({ kind: "site-open-options" }).catch(() => undefined);
          this.destroy();
          return;
      }
    }
    if (target.closest("#p-close")) return this.exit();
    if (target.closest("#p-min")) {
      this.minimized = true;
      this.render();
      this.pill.focus();
      return;
    }
    if (target.closest(".pill")) {
      this.minimized = false;
      this.render("#p-min");
      return;
    }
    if (target.closest("#p-side")) {
      this.side = this.side === "right" ? "left" : "right";
      this.render("#p-side");
      return;
    }
    if (target.closest("#p-theme")) {
      this.theme = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length] ?? "system";
      this.env.saveTheme(this.theme);
      this.render("#p-theme");
      return;
    }
    const clear = target.closest<HTMLElement>("[data-clear]");
    if (clear) {
      const role = clear.dataset["clear"] as Role;
      this.model.clearRole(role);
      this.render("#cursorbox");
      this.announce(
        role === "cut"
          ? { key: "annCutsRemoved" }
          : { key: "annRemoved", args: [{ key: ROLE_NAME_KEYS[role] }] },
      );
      return;
    }
    const nav = target.closest<HTMLElement>("[data-nav]");
    if (nav) {
      const dir = nav.dataset["nav"];
      if (dir === "open") this.openPopAtCursor();
      else if (dir === "up" || dir === "down" || dir === "prev" || dir === "next")
        this.move(dir);
      return;
    }
    const roleButton = target.closest<HTMLElement>("[data-role]");
    if (roleButton) {
      this.choose(roleButton.dataset["role"] as Role);
      return;
    }
    const popAction = target.closest<HTMLElement>("[data-pop]");
    if (popAction && this.popTarget) {
      const el = this.popTarget;
      if (popAction.dataset["pop"] === "notthis") {
        const card = this.model.cardOf(el);
        if (!card) return;
        this.model.dirty = true;
        const result = this.model.excludeCard(card);
        this.closePop(false);
        this.render("#cursorbox");
        if (result.ok)
          this.say(
            result.msg,
            result.undo
              ? () => {
                  result.undo?.();
                  this.render("#cursorbox");
                }
              : null,
          );
        return;
      }
      if (popAction.dataset["pop"] === "clear") {
        const role = this.model.assignedRole(el);
        if (role === "cut") this.model.clearCutOn(el);
        else if (role) this.model.clearRole(role);
        this.closePop(false);
        this.render("#cursorbox");
      }
    }
  }

  private onShadowChange(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!target || !this.drawer.contains(target)) return;
    this.readForm();
    if (target.id === "f-page") {
      const help = this.q("#f-page-h");
      if (help) {
        const form = this.form;
        help.textContent =
          form?.pagination === "load-more" && this.hints.loadMore
            ? t("moreHelpButton", this.hints.loadMore.selector)
            : form?.pagination === "none"
              ? t("moreHelpNone")
              : t("moreHelp");
      }
    }
    if (target.id === "f-method") this.refreshMethodNote();
  }

  private pageTarget(event: Event): Element | null {
    const first = event.composedPath()[0];
    return first instanceof (this.env.win as unknown as { Element: typeof Element }).Element &&
      this.isPage(first)
      ? first
      : null;
  }

  private onMouseMove(event: MouseEvent): void {
    if (this.mode !== "pick" || this.popTarget) return;
    const el = this.pageTarget(event);
    if (el !== this.hover) {
      this.hover = el;
      this.repaint();
    }
  }

  private onPageClick(event: MouseEvent): void {
    if (this.passThrough) return;
    const el = this.pageTarget(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (this.mode === "pick") {
      this.hover = null;
      this.openPop(el, event.clientX, event.clientY);
    } else if (this.mode === "start") {
      this.say([{ key: "toastStartFirst" }]);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const active = this.shadow.activeElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.popTarget) return this.closePop();
      if (this.minimized) {
        this.minimized = false;
        this.render("#p-min");
        return;
      }
      if (this.mode === "preview") {
        this.readForm();
        this.mode = "pick";
        this.render("#cursorbox");
        return;
      }
      if (this.mode === "confirm-exit") return this.setMode(this.prevMode, "#cursorbox");
      return this.exit();
    }
    if (this.mode !== "pick" || event.ctrlKey || event.metaKey || event.altKey) return;
    const inPop = Boolean(active && this.pop.contains(active));
    const onCursor = active?.id === "cursorbox";
    const onPage =
      this.env.doc.activeElement === this.env.doc.body || this.env.doc.activeElement === null;
    if (!inPop && !onCursor && !onPage) return;
    const dirs: Record<string, "up" | "down" | "prev" | "next"> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "prev",
      ArrowRight: "next",
    };
    const dir = dirs[event.key];
    if (dir) {
      event.preventDefault();
      event.stopPropagation();
      this.move(dir);
      return;
    }
    if (inPop && /^[1-8]$/.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const role = ROLES[Number(event.key) - 1];
      if (role) this.choose(role);
      return;
    }
    if (!inPop && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.cursor) this.move("down");
      else this.openPopAtCursor();
    }
  }

  /** Tab stays inside the role window (non-modal, but focus must not get lost). */
  private onPopKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const buttons = Array.from(this.pop.querySelectorAll<HTMLElement>("button"));
    const index = buttons.indexOf(this.shadow.activeElement as HTMLElement);
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (!event.shiftKey && index === buttons.length - 1) {
      event.preventDefault();
      buttons[0]?.focus();
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function firstPageElement(doc: Document, isPage: (el: Element) => boolean): Element | null {
  return Array.from(doc.body?.children ?? []).find(isPage) ?? null;
}
