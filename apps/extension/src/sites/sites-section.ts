import {
  discoverFeeds,
  parseFeed,
  patternsFor,
  ruleIdFor,
  ruleSourceLabel,
  type DiscoveredFeed,
  type SiteRule,
  type SiteRuleInput,
} from "@nmc/core";
import { t, type MessageKey } from "../i18n.js";
import { h, icon, whenText, type Child, type IconName } from "../picker/dom.js";
import { clearRequestBuffer } from "./request-buffer.js";
import type { FetchResult } from "./site-collect.js";
import type { SiteProbeAnswer, SiteWorkerMessage } from "./site-messages.js";
import {
  originPattern,
  requestOrigins,
  siteOrigins,
  unusedOrigins,
  type PermissionsApi,
} from "./site-permissions.js";
import {
  deleteSiteRule,
  exportFileName,
  exportSiteRule,
  importSiteRule,
  loadSiteRules,
  loadSiteStates,
  putSiteState,
  removeSiteState,
  rowStatus,
  sameAddress,
  saveSiteRule,
  stateOf,
  updateSiteState,
  type SiteState,
  type StorageArea,
} from "./site-store.js";
import { SITE_NEW_RULE_KEY } from "./storage-keys.js";

/**
 * Options › Sites (design: rule-picker-mockup.html "Ayarlar · Siteler"):
 * the rule list with health, "Add site" (address check, pattern choice,
 * per-site permission inside the click, RSS/Atom discovery), export /
 * import, delete with Undo. Rules and states live in
 * `chrome.storage.local`; the worker opens the picker and collects.
 */

export interface SitesDeps {
  doc: Document;
  local: StorageArea;
  session: StorageArea;
  permissions: PermissionsApi;
  send(message: SiteWorkerMessage): Promise<unknown>;
  /** Extension-page fetch (host permission granted → no CORS). */
  fetchText(url: string): Promise<FetchResult>;
  now(): string;
  download(fileName: string, text: string): void;
  copy(text: string): Promise<void>;
  /** Undo window of a delete (design: 8 s). */
  undoMs?: number;
}

type PatternChoice = {
  value: string;
  title: MessageKey;
  desc: MessageKey;
  recommended: boolean;
};

export type UrlCheck =
  { ok: true; url: URL; http: boolean } | { ok: false; error: MessageKey; args?: string[] };

const X_HOSTS = /(?:^|\.)(?:x|twitter)\.com$/i;

/** The "Add site" address check (design: Site ekle › URL hatası). */
export function checkSiteUrl(
  raw: string,
  rules: readonly Pick<SiteRule, "url" | "name">[],
): UrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "urlErrEmpty" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { ok: false, error: "urlErrInvalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, error: "urlErrScheme" };
  if (!url.hostname.includes(".") && url.hostname !== "localhost")
    return { ok: false, error: "urlErrInvalid" };
  if (X_HOSTS.test(url.hostname)) return { ok: false, error: "urlErrX" };
  url.hash = "";
  const same = rules.find((rule) => sameAddress(rule.url, url.href));
  if (same) return { ok: false, error: "urlErrDup", args: [same.name] };
  return { ok: true, url, http: url.protocol === "http:" };
}

/** Pattern choices for an address; "section" recommended, "site" when it is the home page. */
export function patternChoices(url: URL): PatternChoice[] {
  const { page, section, site } = patternsFor(url.href);
  const home = url.pathname.replace(/\/+$/, "") === "";
  const choices: PatternChoice[] = [];
  if (!home) {
    choices.push({ value: page, title: "patPage", desc: "patPageDesc", recommended: false });
    choices.push({
      value: section,
      title: "patSection",
      desc: "patSectionDesc",
      recommended: true,
    });
  }
  choices.push({ value: site, title: "patSite", desc: "patSiteDesc", recommended: home });
  return choices;
}

export class SitesSection {
  private rules: SiteRule[] = [];
  private states: Record<string, SiteState> = {};
  private newRuleId: string | null = null;
  private feedOffer: { url: URL; pattern: string; feed: DiscoveredFeed } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private undoFn: (() => void) | null = null;
  private finalizeFn: (() => void) | null = null;

  private readonly addBtn: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly urlInput: HTMLInputElement;
  private readonly urlErr: HTMLElement;
  private readonly patterns: HTMLFieldSetElement;
  private readonly patList: HTMLElement;
  private readonly permNote: HTMLElement;
  private readonly offer: HTMLElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly toastMsg: HTMLElement;
  private readonly toastUndo: HTMLButtonElement;
  readonly exportDlg: HTMLDialogElement;
  private readonly exportText: HTMLTextAreaElement;
  readonly importDlg: HTMLDialogElement;
  private readonly importText: HTMLTextAreaElement;
  private readonly importRes: HTMLElement;
  private readonly importFile: HTMLInputElement;
  readonly noteDlg: HTMLDialogElement;
  private exporting: SiteRule | null = null;
  private noteFor: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly deps: SitesDeps,
  ) {
    const x = this.x.bind(this);
    this.addBtn = x(
      "button",
      {
        class: "btn btn--primary btn--sm",
        type: "button",
        id: "add-btn",
        "aria-expanded": "false",
        "aria-controls": "addform",
      },
      this.i("plus"),
      t("sitesAdd"),
    ) as HTMLButtonElement;
    this.urlInput = x("input", {
      class: "input",
      id: "url-in",
      type: "url",
      inputmode: "url",
      autocomplete: "url",
      spellcheck: "false",
      "aria-describedby": "url-hint url-err",
    }) as HTMLInputElement;
    this.urlErr = x("p", { class: "err", id: "url-err" });
    this.urlErr.hidden = true;
    this.patList = x("div", { id: "pat-list" });
    this.patterns = x(
      "fieldset",
      { class: "patterns", id: "patterns", "aria-describedby": "pat-hint" },
      x("legend", { text: t("patLegend") }),
      this.patList,
      x("p", { class: "hint", id: "pat-hint", text: t("patHint") }),
    ) as HTMLFieldSetElement;
    this.permNote = x("p", { class: "permnote", id: "perm-note" });
    this.offer = x("div", { class: "offer", id: "feed-offer", role: "status" });
    this.offer.hidden = true;
    this.submitBtn = x("button", {
      class: "btn btn--primary",
      type: "submit",
      text: t("addSubmit"),
    }) as HTMLButtonElement;
    this.form = x(
      "form",
      { class: "addform", id: "addform", novalidate: true, "aria-labelledby": "add-h" },
      x("h3", { id: "add-h", text: t("addHeading") }),
      x(
        "div",
        { class: "field" },
        x("label", { for: "url-in", text: t("urlLabel") }),
        this.urlInput,
        x("p", { class: "hint", id: "url-hint", text: t("urlHint") }),
        this.urlErr,
      ),
      this.patterns,
      this.permNote,
      this.offer,
      x(
        "div",
        { class: "btn-row" },
        this.submitBtn,
        x("button", {
          class: "btn btn--ghost",
          type: "button",
          "data-act": "add-cancel",
          text: t("addCancel"),
        }),
      ),
    ) as HTMLFormElement;
    this.form.hidden = true;
    this.list = x("div", { id: "rules-wrap" });

    this.toastMsg = x("span");
    this.toastUndo = x("button", { type: "button", text: t("undo") }) as HTMLButtonElement;
    this.toastUndo.hidden = true;
    this.toast = x(
      "div",
      { class: "toast", role: "status", "aria-live": "polite" },
      this.toastMsg,
      this.toastUndo,
    );
    this.toast.hidden = true;

    this.exportText = x("textarea", {
      readonly: true,
      "aria-label": t("ruleJson"),
    }) as HTMLTextAreaElement;
    this.exportDlg = x(
      "dialog",
      { class: "dlg", "aria-labelledby": "exp-h" },
      x(
        "div",
        { class: "dlg__in" },
        x("h2", { id: "exp-h", text: t("exportHeading") }),
        x("p", { text: t("exportBody") }),
        this.exportText,
        x(
          "div",
          { class: "dlg__foot" },
          x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-close": "",
            text: t("close"),
          }),
          x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-act": "exp-download",
            text: t("exportDownload"),
          }),
          x("button", {
            class: "btn btn--primary btn--sm",
            type: "button",
            "data-act": "exp-copy",
            text: t("exportCopy"),
          }),
        ),
      ),
    ) as HTMLDialogElement;

    this.importText = x("textarea", {
      "aria-label": t("ruleJson"),
      "aria-describedby": "imp-res",
      spellcheck: "false",
      placeholder: '{ "nmcRule": 1, … }',
    }) as HTMLTextAreaElement;
    this.importRes = x("div", { id: "imp-res", class: "dlg__res", role: "status" });
    this.importRes.hidden = true;
    this.importFile = x("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: true,
    }) as HTMLInputElement;
    this.importDlg = x(
      "dialog",
      { class: "dlg", "aria-labelledby": "imp-h" },
      x(
        "form",
        { class: "dlg__in", id: "imp-form", novalidate: true },
        x("h2", { id: "imp-h", text: t("importHeading") }),
        x("p", { text: t("importBody") }),
        this.importText,
        this.importRes,
        this.importFile,
        x(
          "div",
          { class: "dlg__foot" },
          x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-act": "imp-file",
            text: t("importFile"),
          }),
          x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-close": "",
            text: t("addCancel"),
          }),
          x("button", {
            class: "btn btn--primary btn--sm",
            type: "submit",
            text: t("importSubmit"),
          }),
        ),
      ),
    ) as HTMLDialogElement;

    this.noteDlg = x(
      "dialog",
      { class: "dlg", "aria-labelledby": "note-h", "aria-describedby": "note-d" },
      x(
        "div",
        { class: "dlg__in" },
        x("h2", { id: "note-h", text: t("pageNoteHeading") }),
        x("p", { id: "note-d", text: t("pageNoteBody") }),
        x(
          "div",
          { class: "dlg__foot" },
          x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-close": "",
            text: t("addCancel"),
          }),
          x("button", {
            class: "btn btn--primary btn--sm",
            type: "button",
            "data-act": "note-allow",
            text: t("pageNoteAllow"),
          }),
        ),
      ),
    ) as HTMLDialogElement;

    container.replaceChildren(
      x("h2", { id: "sites-h", text: t("sitesHeading") }),
      x("p", { class: "lead", text: t("sitesLead") }),
      x(
        "div",
        { class: "toolbar" },
        this.addBtn,
        x("button", {
          class: "btn btn--ghost btn--sm",
          type: "button",
          "data-act": "import",
          text: t("sitesImport"),
        }),
      ),
      this.form,
      this.list,
      x("p", { class: "opt__foot", text: t("sitesFoot") }),
      this.toast,
      this.exportDlg,
      this.importDlg,
      this.noteDlg,
    );
    this.bind();
  }

  private x(
    tag: string,
    attrs: Record<string, string | number | boolean | undefined> = {},
    ...children: Child[]
  ): HTMLElement {
    return h(this.deps.doc, tag, attrs, ...children);
  }

  private i(name: IconName): SVGSVGElement {
    return icon(this.deps.doc, name);
  }

  // --- data -----------------------------------------------------------

  async refresh(): Promise<void> {
    this.rules = await loadSiteRules(this.deps.local);
    this.states = await loadSiteStates(this.deps.local);
    const fresh = (await this.deps.session.get([SITE_NEW_RULE_KEY]))[SITE_NEW_RULE_KEY];
    if (typeof fresh === "string" && this.rules.some((rule) => rule.id === fresh)) {
      this.newRuleId = fresh;
      await this.deps.session.remove([SITE_NEW_RULE_KEY]);
      this.renderList();
      this.focusRow(fresh, "toggle");
      return;
    }
    this.renderList();
  }

  // --- list -----------------------------------------------------------

  renderList(): void {
    const x = this.x.bind(this);
    if (this.rules.length === 0) {
      this.list.replaceChildren(
        x(
          "div",
          { class: "empty" },
          x("div", { class: "empty__icon", "aria-hidden": "true" }, this.i("globe")),
          x("h3", { text: t("emptyHeading") }),
          x("p", { text: t("emptyBody") }),
          x(
            "div",
            { class: "btn-row btn-row--center" },
            x("button", {
              class: "btn btn--primary",
              type: "button",
              "data-act": "add",
              text: t("sitesAdd"),
            }),
            x("button", {
              class: "btn btn--ghost",
              type: "button",
              "data-act": "import",
              text: t("emptyImport"),
            }),
          ),
        ),
      );
      return;
    }
    // A background collect re-renders the list: keep the keyboard where it was.
    const active = this.deps.doc.activeElement as HTMLElement | null;
    const kept =
      active && this.list.contains(active)
        ? { act: active.dataset["act"], id: active.dataset["id"] }
        : null;
    const ul = x("ul", { class: "rules", "aria-label": t("rulesAria", this.rules.length) });
    for (const rule of this.rules) ul.append(this.row(rule));
    this.list.replaceChildren(ul);
    if (kept?.act && kept.id) {
      Array.from(ul.querySelectorAll<HTMLElement>(`[data-act="${kept.act}"]`))
        .find((el) => el.dataset["id"] === kept.id)
        ?.focus();
    }
  }

  private row(rule: SiteRule): HTMLElement {
    const x = this.x.bind(this);
    const state = stateOf(this.states, rule.id);
    const id = domId(rule.id);
    const ava = x("span", {
      class: "site-ava",
      "aria-hidden": "true",
      text: (rule.name[0] ?? "?").toLocaleUpperCase(t("langCode")),
    });
    ava.style.setProperty("background", `hsl(${hue(rule.id)} 45% 36%)`);
    const toggle = x("input", {
      type: "checkbox",
      "data-act": "toggle",
      "data-id": rule.id,
      "aria-describedby": `rn-${id}`,
    }) as HTMLInputElement;
    toggle.checked = state.enabled;
    const li = x(
      "li",
      {
        class: `rule${state.enabled ? "" : " is-off"}${rule.id === this.newRuleId ? " is-new" : ""}`,
        id: `rule-${id}`,
        "aria-labelledby": `rn-${id}`,
      },
      x(
        "div",
        { class: "rule__row" },
        ava,
        x(
          "div",
          { class: "rule__main" },
          x("p", { class: "rule__name", id: `rn-${id}`, text: rule.name }),
          x("code", {
            class: "rule__pat",
            title: rule.match.join(", "),
            text: rule.match.join(", "),
          }),
          x("div", { class: "rule__status" }, ...this.statusParts(rule, state)),
        ),
        x(
          "div",
          { class: "rule__acts" },
          x("label", { class: "switch" }, toggle, x("span", { text: t("toggleLabel") })),
          x(
            "button",
            {
              class: "icon-btn",
              type: "button",
              "data-act": "repick",
              "data-id": rule.id,
              "aria-label": t("rowRepickAria", rule.name),
              title: t("rowRepick"),
            },
            this.i("pointer"),
          ),
          x(
            "button",
            {
              class: "icon-btn",
              type: "button",
              "data-act": "export",
              "data-id": rule.id,
              "aria-label": t("rowExportAria", rule.name),
              title: t("rowExport"),
            },
            this.i("download"),
          ),
          x(
            "button",
            {
              class: "icon-btn",
              type: "button",
              "data-act": "delete",
              "data-id": rule.id,
              "aria-label": t("rowDeleteAria", rule.name),
              title: t("rowDelete"),
            },
            this.i("trash"),
          ),
        ),
      ),
    );
    const band = this.band(rule, state);
    if (band) li.append(band);
    return li;
  }

  private chip(kind: "ok" | "warn" | "info", iconName: IconName, text: string): HTMLElement {
    return this.x("span", { class: `chip chip--${kind}` }, this.i(iconName), text);
  }

  private when(iso: string | undefined): string {
    return iso ? whenText(iso, Date.parse(this.deps.now()), t("langCode"), t("today")) : "";
  }

  private statusParts(rule: SiteRule, state: SiteState): Child[] {
    const status = rowStatus(rule, state);
    const x = this.x.bind(this);
    const line = (text: string): HTMLElement => x("span", { text });
    const last = state.lastFetchedAt
      ? t("statusLast", this.when(state.lastFetchedAt), state.lastItemCount ?? 0)
      : t("statusNever");
    const browse =
      rule.collect.request && state.lastBrowseAt
        ? ` · ${t("statusBrowse", this.when(state.lastBrowseAt))}`
        : "";
    switch (status.kind) {
      case "off":
        return [
          this.chip("info", "minus", t("chipOff")),
          line(
            state.lastFetchedAt
              ? t("statusOff", this.when(state.lastFetchedAt))
              : t("statusOffNever"),
          ),
        ];
      case "permission":
        return [this.chip("info", "question", t("chipPermission")), line(last)];
      case "new":
        return [
          this.chip("ok", "check", t("chipSaved")),
          line(t("statusSaved", status.savedItemCount)),
        ];
      case "pending":
        return [this.chip("info", "minus", t("chipNew")), line(t("statusPending"))];
      case "ok":
        return [
          this.chip("ok", "check", t("chipOk")),
          line(t("statusLast", this.when(status.at), status.items) + browse),
        ];
      case "few-items":
        return [
          this.chip("warn", "alert", t("chipFew")),
          line(
            status.typical !== undefined && status.typical > status.items
              ? t("statusFewUsually", this.when(status.at), status.items, status.typical)
              : t("statusFewMin", this.when(status.at), status.items, status.minItems),
          ),
        ];
      case "low-coverage":
        return [
          this.chip("warn", "alert", t("chipLowCoverage")),
          line(t("statusLowCoverage", this.when(status.at), status.items)),
        ];
      case "broken":
        return [
          this.chip("warn", "alert", t("chipBroken")),
          line(
            status.lastSuccessAt
              ? t("statusBroken", status.fails, this.when(status.lastSuccessAt))
              : t("statusBrokenNever", status.fails),
          ),
        ];
      case "fetch-error":
        return [
          this.chip("info", "question", t("chipFetchError")),
          line(t("statusFetchError", this.when(status.at), status.message ?? "?")),
        ];
      case "visible-tab":
        return [
          this.chip("warn", "alert", t("chipVisibleTab")),
          line(t("statusVisibleTab", this.when(status.at)) + browse),
        ];
      case "page-note":
        return [this.chip("info", "question", t("chipPageNote")), line(t("statusPageNote"))];
      case "json-unsupported":
        return [
          this.chip("info", "question", t("chipJson")),
          line(t("statusJson", this.when(status.at))),
        ];
    }
  }

  private band(rule: SiteRule, state: SiteState): HTMLElement | null {
    const status = rowStatus(rule, state);
    const x = this.x.bind(this);
    const button = (act: string, text: string, iconName?: IconName): HTMLElement =>
      x(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          "data-act": act,
          "data-id": rule.id,
        },
        iconName ? this.i(iconName) : null,
        text,
      );
    const wrap = (info: boolean, text: Child[], ...buttons: HTMLElement[]): HTMLElement =>
      x(
        "div",
        { class: info ? "rule__band rule__band--info" : "rule__band" },
        x("p", {}, ...text),
        ...buttons,
      );
    switch (status.kind) {
      case "broken":
        return wrap(
          false,
          [
            x("strong", { text: t("bandBrokenStrong") }),
            " ",
            status.lastSuccessCount !== undefined
              ? t("bandBroken", status.lastSuccessCount)
              : t("bandBrokenNever"),
          ],
          button("repick", t("rowRepick"), "pointer"),
        );
      case "few-items":
        return wrap(
          false,
          [t("bandFew", status.minItems)],
          button("repick", t("bandCheck"), "pointer"),
        );
      case "permission":
        return wrap(true, [t("bandPermission")], button("perm", t("bandAllow")));
      case "visible-tab":
        return wrap(
          false,
          [t("bandVisibleTab")],
          button("collect-visible", t("bandCollectVisible")),
          button("page-note", t("bandPageEachTime")),
        );
      case "page-note":
        return wrap(true, [t("bandPageNote")], button("page-note", t("bandConfirm")));
      case "json-unsupported":
        return wrap(true, [t("bandJson")]);
      default:
        return null;
    }
  }

  private focusRow(id: string, act: string): void {
    const row = this.list.querySelector(`#rule-${cssEscape(domId(id))}`);
    const target = row?.querySelector<HTMLElement>(`[data-act="${act}"]`);
    (row as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
    target?.focus();
  }

  // --- toast ----------------------------------------------------------

  say(
    text: string,
    undo: (() => void) | null = null,
    finalize: (() => void) | null = null,
  ): void {
    this.finishPending();
    this.toastMsg.textContent = text;
    this.toast.hidden = false;
    this.undoFn = undo;
    this.finalizeFn = finalize;
    this.toastUndo.hidden = !undo;
    this.restartToast();
  }

  private restartToast(): void {
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(
      () => {
        this.toast.hidden = true;
        this.finishPending();
      },
      this.undoFn ? (this.deps.undoMs ?? 8_000) : 2_800,
    );
  }

  /** The undo window closed: the delete becomes final. */
  private finishPending(): void {
    const finalize = this.finalizeFn;
    this.finalizeFn = null;
    this.undoFn = null;
    finalize?.();
  }

  // --- add site -------------------------------------------------------

  openAdd(open: boolean): void {
    this.form.hidden = !open;
    this.addBtn.setAttribute("aria-expanded", String(open));
    this.feedOffer = null;
    this.offer.hidden = true;
    if (open) {
      this.validate(false);
      this.urlInput.focus();
      this.urlInput.select();
    } else {
      this.addBtn.focus();
    }
  }

  /** Shows the error only once the field was left (then live while typing). */
  validate(showError: boolean): UrlCheck {
    const check = checkSiteUrl(this.urlInput.value, this.rules);
    const message = check.ok ? "" : t(check.error, ...(check.args ?? []));
    this.urlErr.hidden = !(showError && message);
    this.urlErr.replaceChildren(
      ...(message ? [this.i("alert"), this.x("span", { text: message })] : []),
    );
    this.urlInput.setAttribute("aria-invalid", String(Boolean(showError && message)));
    this.patterns.hidden = !check.ok;
    this.permNote.hidden = !check.ok;
    if (check.ok) {
      const checked = this.form.querySelector<HTMLInputElement>(
        'input[name="pat"]:checked',
      )?.value;
      const choices = patternChoices(check.url);
      this.patList.replaceChildren(
        ...choices.map((choice, index) => {
          const radio = this.x("input", {
            type: "radio",
            name: "pat",
            value: choice.value,
          }) as HTMLInputElement;
          radio.checked = checked
            ? checked === choice.value
            : choice.recommended || (choices.length === 1 && index === 0);
          return this.x(
            "label",
            { class: "pat" },
            radio,
            this.x(
              "span",
              {},
              this.x("code", { text: choice.value }),
              choice.recommended
                ? this.x("span", { class: "rec", text: ` ${t("patRecommended")}` })
                : null,
              this.x("small", { text: `${t(choice.title)} — ${t(choice.desc)}` }),
            ),
          );
        }),
      );
      if (!this.patList.querySelector("input:checked")) {
        const first = this.patList.querySelector<HTMLInputElement>("input");
        if (first) first.checked = true;
      }
      this.permNote.replaceChildren(
        this.i("lock"),
        this.x("span", {
          text: t("permNote", check.url.hostname) + (check.http ? ` ${t("permNoteHttp")}` : ""),
        }),
      );
    }
    return check;
  }

  /** "Allow and open the page": the permission is asked synchronously, inside the click. */
  private onAddSubmit(): void {
    const check = this.validate(true);
    if (!check.ok) {
      this.urlInput.focus();
      return;
    }
    const pattern = this.form.querySelector<HTMLInputElement>(
      'input[name="pat"]:checked',
    )?.value;
    if (!pattern) return;
    const origin = originPattern(check.url.href);
    const granted = requestOrigins(this.deps.permissions, origin ? [origin] : []);
    void this.afterGrant(granted, check.url, pattern);
  }

  private async afterGrant(
    granted: Promise<boolean>,
    url: URL,
    pattern: string,
  ): Promise<void> {
    if (!(await granted)) {
      this.say(t("permDenied", url.hostname));
      return;
    }
    this.submitBtn.disabled = true;
    this.offer.hidden = false;
    this.offer.replaceChildren(this.x("p", { class: "hint", text: t("feedChecking") }));
    const feed = await this.findFeed(url);
    this.submitBtn.disabled = false;
    if (feed) {
      this.feedOffer = { url, pattern, feed };
      this.offer.replaceChildren(
        this.x(
          "p",
          { class: "offer__text" },
          this.i("rss"),
          this.x("span", { text: t("feedFound", feed.title ?? feed.url) }),
        ),
        this.x(
          "div",
          { class: "btn-row" },
          this.x("button", {
            class: "btn btn--primary btn--sm",
            type: "button",
            "data-act": "use-feed",
            text: t("feedUse"),
          }),
          this.x("button", {
            class: "btn btn--ghost btn--sm",
            type: "button",
            "data-act": "pick-anyway",
            text: t("feedPickAnyway"),
          }),
        ),
      );
      this.offer.querySelector<HTMLElement>("[data-act='use-feed']")?.focus();
      return;
    }
    this.offer.hidden = true;
    await this.openPicker({ url: url.href, pattern });
  }

  /** The page's announced RSS/Atom feeds (first one offered). */
  private async findFeed(url: URL): Promise<DiscoveredFeed | null> {
    const page = await this.deps.fetchText(url.href).catch(() => null);
    if (!page?.ok) return null;
    const doc = new DOMParser().parseFromString(page.text, "text/html");
    return discoverFeeds(doc, page.finalUrl)[0] ?? null;
  }

  private async openPicker(target: {
    url: string;
    pattern: string;
    repickOf?: string;
  }): Promise<void> {
    try {
      const answer = (await this.deps.send({ kind: "site-picker-open", target })) as
        { ok?: boolean; message?: string } | undefined;
      if (answer?.ok !== true) {
        this.say(t("pickerFailed", answer?.message ?? "?"));
        return;
      }
      this.openAdd(false);
      this.say(t("pickerOpening"));
    } catch (error) {
      this.say(t("pickerFailed", String(error)));
    }
  }

  /** "Use the feed": a feed-only rule, tested once. The feed's own host is asked inside the click. */
  private onUseFeed(): void {
    const offer = this.feedOffer;
    if (!offer) return;
    const feedOrigin = originPattern(offer.feed.url);
    const granted =
      feedOrigin && feedOrigin !== originPattern(offer.url.href)
        ? requestOrigins(this.deps.permissions, [feedOrigin])
        : Promise.resolve(true);
    void this.addFeedRule(granted, offer.url, offer.pattern, offer.feed);
  }

  private async addFeedRule(
    granted: Promise<boolean>,
    url: URL,
    pattern: string,
    feed: DiscoveredFeed,
  ): Promise<void> {
    if (!(await granted)) {
      this.say(t("permDenied", new URL(feed.url).hostname));
      return;
    }
    const now = this.deps.now();
    const name = (feed.title?.trim() || url.hostname).slice(0, 80);
    const input: SiteRuleInput = {
      nmcRule: 1,
      id: ruleIdFor(url.href),
      name,
      url: url.href,
      match: [pattern],
      collect: { method: "rss", rssUrl: feed.url },
      origin: "manual",
      createdAt: now,
      updatedAt: now,
    };
    const fetched = await this.deps
      .fetchText(feed.url)
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    let count = 0;
    try {
      if (!fetched.ok)
        throw new Error(
          "status" in fetched && fetched.status !== undefined
            ? `HTTP ${fetched.status}`
            : fetched.message,
        );
      count = parseFeed(fetched.text, {
        sourceLabel: ruleSourceLabel({ name }),
        feedUrl: fetched.finalUrl,
      }).length;
    } catch (error) {
      this.offer.replaceChildren(
        this.x(
          "p",
          { class: "err", role: "alert" },
          this.i("alert"),
          this.x("span", {
            text: t("feedUnreadable", String((error as Error).message ?? error)),
          }),
        ),
      );
      return;
    }
    const rule = await saveSiteRule(this.deps.local, input);
    await updateSiteState(this.deps.local, rule.id, {
      enabled: true,
      permissionGranted: true,
      savedItemCount: count,
    });
    this.openAdd(false);
    this.newRuleId = rule.id;
    await this.refresh();
    this.focusRow(rule.id, "toggle");
    this.say(t("feedAdded", rule.name, count));
  }

  // --- row actions ----------------------------------------------------

  private ruleById(id: string | undefined): SiteRule | undefined {
    return this.rules.find((rule) => rule.id === id);
  }

  private onListClick(button: HTMLElement): void {
    const rule = this.ruleById(button.dataset["id"]);
    switch (button.dataset["act"]) {
      case "add":
        return this.openAdd(true);
      case "import":
        return this.openImport();
      case "repick":
        if (rule)
          void this.openPicker({
            url: rule.url,
            pattern: rule.match[0] ?? patternsFor(rule.url).section,
            repickOf: rule.id,
          });
        return;
      case "perm":
        if (rule)
          void this.grant(rule, requestOrigins(this.deps.permissions, siteOrigins(rule)));
        return;
      case "export":
        if (rule) this.openExport(rule);
        return;
      case "delete":
        if (rule) void this.remove(rule);
        return;
      case "collect-visible":
        if (rule) void this.collectVisible(rule);
        return;
      case "page-note":
        if (rule) {
          this.noteFor = rule.id;
          this.noteDlg.showModal();
        }
        return;
    }
  }

  private async grant(rule: SiteRule, granted: Promise<boolean>): Promise<void> {
    if (!(await granted)) {
      this.say(t("permDenied", new URL(rule.url).hostname));
      return;
    }
    await updateSiteState(this.deps.local, rule.id, { permissionGranted: true });
    await this.refresh();
    this.focusRow(rule.id, "repick");
    this.say(t("permGranted", rule.name));
  }

  private async toggle(id: string, enabled: boolean): Promise<void> {
    await updateSiteState(this.deps.local, id, { enabled });
    await this.refresh();
    this.focusRow(id, "toggle");
  }

  /** Delete now, Undo for 8 s; the site's permission is given back only when the delete is final. */
  async remove(rule: SiteRule): Promise<void> {
    const state = stateOf(this.states, rule.id);
    const index = this.rules.indexOf(rule);
    await deleteSiteRule(this.deps.local, rule.id);
    await removeSiteState(this.deps.local, rule.id);
    await this.refresh();
    const next =
      this.list.querySelectorAll<HTMLElement>(".rule [data-act='delete']")[index] ??
      this.list.querySelector<HTMLElement>(".rule:last-child [data-act='delete']") ??
      this.addBtn;
    next.focus();
    this.say(
      t("deleted", rule.name),
      () => void this.restore(rule, state),
      () => void this.finalizeDelete(rule),
    );
  }

  private async restore(rule: SiteRule, state: SiteState): Promise<void> {
    this.finalizeFn = null;
    this.toast.hidden = true;
    await saveSiteRule(this.deps.local, rule);
    await putSiteState(this.deps.local, rule.id, state);
    await this.refresh();
    this.focusRow(rule.id, "delete");
  }

  private async finalizeDelete(rule: SiteRule): Promise<void> {
    await clearRequestBuffer(this.deps.session, rule.id).catch(() => undefined);
    const unused = unusedOrigins(rule, this.rules);
    if (unused.length > 0)
      await this.deps.permissions.remove({ origins: unused }).catch(() => false);
  }

  private async collectVisible(rule: SiteRule): Promise<void> {
    this.say(t("visibleCollecting"));
    try {
      const answer = (await this.deps.send({ kind: "site-collect-visible", id: rule.id })) as
        SiteProbeAnswer | undefined;
      this.say(
        answer?.ok && answer.count > 0
          ? t("visibleDone", rule.name, answer.count)
          : t("visibleFailed", rule.name, answer?.message ?? answer?.verdict ?? "?"),
      );
    } catch (error) {
      this.say(t("visibleFailed", rule.name, String(error)));
    }
    await this.refresh();
  }

  private async acceptPageNote(): Promise<void> {
    const rule = this.ruleById(this.noteFor ?? undefined);
    this.noteDlg.close();
    if (!rule) return;
    await saveSiteRule(this.deps.local, {
      ...rule,
      collect: { ...rule.collect, method: "page" },
      updatedAt: this.deps.now(),
    });
    await updateSiteState(this.deps.local, rule.id, { pageNoteAccepted: true });
    await this.refresh();
    this.focusRow(rule.id, "toggle");
    this.say(t("pageNoteAccepted", rule.name));
  }

  // --- export / import -------------------------------------------------

  openExport(rule: SiteRule): void {
    this.exporting = rule;
    this.exportText.value = exportSiteRule(rule);
    this.exportDlg.showModal();
  }

  openImport(): void {
    this.importText.value = "";
    this.importText.removeAttribute("aria-invalid");
    this.importRes.hidden = true;
    this.importDlg.showModal();
    this.importText.focus();
  }

  private showImportErrors(lines: string[]): void {
    this.importRes.hidden = false;
    this.importRes.className = "dlg__res dlg__res--err";
    const ul = this.x("ul");
    for (const line of lines) ul.append(this.x("li", { text: line }));
    this.importRes.replaceChildren(this.x("strong", { text: t("importErrHeading") }), ul);
    this.importText.setAttribute("aria-invalid", "true");
    this.importText.focus();
  }

  /** "Check and add": validate (core), ask the site's permission inside the click, test once. */
  onImportSubmit(): void {
    const result = importSiteRule(this.importText.value, this.rules);
    if (!result.ok) {
      this.showImportErrors(
        result.duplicateOf !== undefined
          ? [t("importDuplicate", result.duplicateOf)]
          : result.errors,
      );
      return;
    }
    this.importText.removeAttribute("aria-invalid");
    const granted = requestOrigins(this.deps.permissions, siteOrigins(result.rule));
    void this.finishImport(result.rule, granted);
  }

  private async finishImport(rule: SiteRule, granted: Promise<boolean>): Promise<void> {
    this.importRes.hidden = false;
    this.importRes.className = "dlg__res";
    this.importRes.textContent = t("importTesting");
    const permitted = await granted;
    let count = 0;
    let staticWorked = false;
    // Why the test gave nothing (a refusal, an error), so "0 items" is never silent.
    let testProblem: string | undefined;
    if (permitted) {
      const probe = (await this.deps
        .send({ kind: "site-probe", rule })
        .catch((error: unknown) => ({ ok: false, message: String(error) }))) as
        Partial<SiteProbeAnswer> | undefined;
      count = probe?.count ?? 0;
      staticWorked = probe?.staticWorked === true;
      if (count === 0 && (probe?.count === undefined || probe.message)) {
        testProblem = probe?.message ?? "?";
      }
    }
    const saved = await saveSiteRule(this.deps.local, rule);
    await updateSiteState(this.deps.local, saved.id, {
      enabled: true,
      permissionGranted: permitted,
      ...(permitted ? { savedItemCount: count } : {}),
      ...(staticWorked ? { staticKnownGood: true } : {}),
    });
    this.importDlg.close();
    this.newRuleId = saved.id;
    await this.refresh();
    this.focusRow(saved.id, "repick");
    this.say(
      !permitted
        ? t("importAddedNoPerm", saved.name)
        : testProblem !== undefined
          ? t("importAddedTestFailed", saved.name, testProblem)
          : t("importAdded", saved.name, count),
    );
  }

  private async readImportFile(file: File): Promise<void> {
    if (file.size > 64 * 1024) {
      this.showImportErrors([t("importFileTooBig")]);
      return;
    }
    try {
      this.importText.value = await file.text();
      this.importRes.hidden = true;
      this.importText.focus();
    } catch {
      this.showImportErrors([t("importFileRead")]);
    }
  }

  // --- events ---------------------------------------------------------

  private bind(): void {
    this.addBtn.addEventListener("click", () => this.openAdd(this.form.hidden));
    this.urlInput.addEventListener("input", () => {
      this.offer.hidden = true;
      this.validate(this.urlInput.getAttribute("aria-invalid") === "true");
    });
    this.urlInput.addEventListener("blur", () => this.validate(true));
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.onAddSubmit();
    });
    this.container.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      const button = target?.closest<HTMLElement>("[data-act]");
      if (!button || button.tagName === "INPUT") return;
      switch (button.dataset["act"]) {
        case "add-cancel":
          return this.openAdd(false);
        case "use-feed":
          return this.onUseFeed();
        case "pick-anyway": {
          const offer = this.feedOffer;
          if (offer) void this.openPicker({ url: offer.url.href, pattern: offer.pattern });
          return;
        }
        case "exp-copy":
          if (this.exporting) {
            void this.deps.copy(this.exportText.value).then(
              () => this.say(t("copied")),
              () => this.say(t("copyFailed")),
            );
          }
          return;
        case "exp-download":
          if (this.exporting) {
            const name = exportFileName(this.exporting);
            this.deps.download(name, this.exportText.value);
            this.say(t("downloaded", name));
          }
          return;
        case "imp-file":
          this.importFile.click();
          return;
        case "note-allow":
          void this.acceptPageNote();
          return;
        default:
          this.onListClick(button);
      }
    });
    this.container.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement | null;
      if (input?.dataset["act"] === "toggle" && input.dataset["id"]) {
        void this.toggle(input.dataset["id"], input.checked);
      }
    });
    this.importFile.addEventListener("change", () => {
      const file = this.importFile.files?.[0];
      if (file) void this.readImportFile(file);
      this.importFile.value = "";
    });
    this.importDlg.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.onImportSubmit();
    });
    for (const dialog of [this.exportDlg, this.importDlg, this.noteDlg]) {
      dialog.addEventListener("click", (event) => {
        if ((event.target as Element | null)?.closest("[data-close]")) dialog.close();
      });
    }
    this.toastUndo.addEventListener("click", () => {
      const undo = this.undoFn;
      this.undoFn = null;
      this.finalizeFn = null;
      this.toast.hidden = true;
      undo?.();
    });
    // The undo window pauses while the pointer or focus is on the notice.
    this.toast.addEventListener("mouseenter", () => clearTimeout(this.toastTimer));
    this.toast.addEventListener("mouseleave", () => this.restartToast());
    this.toast.addEventListener("focusin", () => clearTimeout(this.toastTimer));
    this.toast.addEventListener("focusout", () => this.restartToast());
  }
}

/** A rule id as a DOM id fragment ("news.example/world" → "news-example-world-…"). */
export function domId(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60)}-${hash.toString(36)}`;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** A stable avatar hue per rule. */
function hue(id: string): number {
  let hash = 7;
  for (const ch of id) hash = (hash * 33 + ch.charCodeAt(0)) % 360;
  return hash;
}
