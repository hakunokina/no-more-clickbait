import {
  SiteRuleSchema,
  urlMatchesPattern,
  type FeedBatch,
  type SiteCollectOutcome,
  type SiteRule,
} from "@nmc/core";
import { isSiteRequestCaptureMessage } from "./hook-protocol.js";
import { extractInOffscreen } from "./offscreen-client.js";
import { addToRequestBuffer, takeRequestBuffer } from "./request-buffer.js";
import { fetchText } from "./fetch-text.js";
import { collectSite, type CollectDeps, type RequestBuffer } from "./site-collect.js";
import { hookOrigins, syncHookRegistrations } from "./site-hooks.js";
import {
  isSiteWorkerMessage,
  type SitePickerSaveAnswer,
  type SiteProbeAnswer,
  type SiteWorkerMessage,
} from "./site-messages.js";
import { chromePageBrowser, collectViaPage, type PageBrowser } from "./site-page.js";
import { hasSitePermission, rulesAffectedBy } from "./site-permissions.js";
import { runOneSite, runSites } from "./site-run.js";
import {
  loadSiteRules,
  loadSiteStates,
  migrateLegacySiteStates,
  mutateSiteState,
  saveSiteRule,
  stateOf,
  updateSiteState,
  type SiteState,
} from "./site-store.js";
import { SITE_NEW_RULE_KEY, SITE_PICKER_TABS_KEY, touchesSites } from "./storage-keys.js";

/**
 * The worker side of custom sites: opens the picker in a tab, stores
 * what it saves, keeps permission state and the "more" hook
 * registrations in sync, buffers captured "more" responses, and collects
 * the sites alongside X (`collectSitesForCollection`, leader decision
 * #777). background.ts wires it in with `installSiteWorker`.
 */

const local = chrome.storage.local;
const session = chrome.storage.session;

function restoreRequestBuffer(siteId: string, buffer: RequestBuffer): Promise<void> {
  const at = buffer.lastAt ?? new Date().toISOString();
  return addToRequestBuffer(session, siteId, buffer.items, at).then(() => undefined);
}

const collectDeps: CollectDeps = {
  fetchText,
  extractStatic: extractInOffscreen,
  takeRequestBuffer: (siteId) => takeRequestBuffer(session, siteId),
  collectViaPage: (rule) => collectViaPage(rule, chromePageBrowser),
};

/**
 * Tab ids the picker was opened in: only they may save through it. In
 * session storage, so a restarted worker still knows them.
 */
async function pickerTabs(): Promise<number[]> {
  const stored = (await session.get(SITE_PICKER_TABS_KEY))[SITE_PICKER_TABS_KEY];
  return Array.isArray(stored)
    ? stored.filter((id): id is number => typeof id === "number")
    : [];
}

async function setPickerTab(tabId: number, open: boolean): Promise<void> {
  const tabs = (await pickerTabs()).filter((id) => id !== tabId);
  if (open) tabs.push(tabId);
  await session.set({ [SITE_PICKER_TABS_KEY]: tabs.slice(-20) });
}

async function waitForTabLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openPicker(target: {
  url: string;
  pattern: string;
  repickOf?: string;
}): Promise<void> {
  const rules = await loadSiteRules(local);
  const rule = target.repickOf ? rules.find((r) => r.id === target.repickOf) : undefined;
  const tab = await chrome.tabs.create({ url: target.url, active: true });
  if (tab.id === undefined) throw new Error("the browser returned no tab");
  const tabId = tab.id;
  await setPickerTab(tabId, true);
  await waitForTabLoad(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["picker.js"] });
  await chrome.tabs.sendMessage(tabId, {
    kind: "site-picker-init",
    target,
    ...(rule ? { rule } : {}),
  });
}

async function saveFromPicker(
  input: unknown,
  foundCount: number,
): Promise<SitePickerSaveAnswer> {
  const parsed = SiteRuleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const rule = await saveSiteRule(local, parsed.data);
  const probe = await probeRule(rule);
  const granted = await hasSitePermission(chrome.permissions, rule);
  await mutateSiteState(local, rule.id, (previous) => {
    const next: SiteState = {
      ...previous,
      permissionGranted: granted,
      savedItemCount: foundCount,
    };
    if (probe.staticWorked) next.staticKnownGood = true;
    // A re-picked rule starts its health over.
    delete next.lastStatus;
    delete next.consecutiveZero;
    return next;
  });
  await session.set({ [SITE_NEW_RULE_KEY]: rule.id });
  return { ok: true, id: rule.id, staticWorked: probe.staticWorked === true };
}

/** Runs a rule once (feed/static only, never a window), delivering nothing. */
async function probeRule(rule: SiteRule): Promise<SiteProbeAnswer> {
  const probed: SiteRule =
    rule.collect.method === "page" || rule.collect.method === "request"
      ? { ...rule, collect: { ...rule.collect, method: "auto" } }
      : rule;
  try {
    const result = await collectSite(
      probed,
      { ...collectDeps, takeRequestBuffer: () => Promise.resolve(null) },
      { pageNoteAccepted: false, staticKnownGood: true },
    );
    return {
      ok: result.items.length > 0,
      count: result.items.length,
      verdict: result.verdict,
      method: result.method,
      staticWorked: result.method === "static" && result.items.length > 0,
      ...(result.message ? { message: result.message } : {}),
    };
  } catch (error) {
    return { ok: false, count: 0, message: String(error) };
  }
}

/** "Collect on the page": a visible tab, the rule's own pagination, then that tab closes. */
async function collectVisible(
  id: string,
  sendBatch: (batch: FeedBatch) => boolean,
): Promise<SiteProbeAnswer> {
  const rule = (await loadSiteRules(local)).find((r) => r.id === id);
  if (!rule) return { ok: false, count: 0, message: "rule not found" };
  const before = stateOf(await loadSiteStates(local), id);
  let openedTab: number | undefined;
  const visible: PageBrowser = {
    ...chromePageBrowser,
    async openHiddenPage(url: string) {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab.id === undefined) throw new Error("the browser returned no tab");
      openedTab = tab.id;
      return { windowId: tab.windowId, tabId: tab.id };
    },
    // A tab of the user's own window: close only that tab, never the window.
    async closePage() {
      if (openedTab !== undefined) await chrome.tabs.remove(openedTab);
    },
  };
  const run = await runOneSite(
    { ...rule, collect: { ...rule.collect, method: "page" } },
    { ...before, pageNoteAccepted: true },
    {
      collect: { ...collectDeps, collectViaPage: (r) => collectViaPage(r, visible) },
      sendBatch,
      // Folded into the stored state, so the user's own page-method choice stays as it was.
      updateState: (siteId, change) => mutateSiteState(local, siteId, change),
      restoreRequestBuffer,
      now: () => new Date().toISOString(),
    },
  );
  return {
    ok: run.outcome.status === "ok",
    count: run.outcome.itemCount,
    ...(run.result ? { verdict: run.result.verdict, method: run.result.method } : {}),
    ...(run.outcome.message ? { message: run.outcome.message } : {}),
  };
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/** A captured "more" response: re-validated against the rule, parsed offscreen, buffered. */
async function onRequestCapture(
  siteId: string,
  url: string,
  bodyText: string,
  pageUrl: string | undefined,
): Promise<void> {
  const rule = (await loadSiteRules(local)).find((r) => r.id === siteId);
  const state = stateOf(await loadSiteStates(local), siteId);
  if (rule?.collect.request?.format !== "html") return;
  if (!state.enabled || !state.permissionGranted) return;
  if (!urlMatchesPattern(rule.collect.request.match, url)) return;
  // Only the rule's own site may fill its buffer (the relay runs on every hooked site).
  if (!pageUrl || !sameHost(pageUrl, rule.url)) return;
  const { items } = await extractInOffscreen(bodyText, pageUrl, rule);
  const now = new Date().toISOString();
  if (items.length > 0) await addToRequestBuffer(session, siteId, items, now);
  await updateSiteState(local, siteId, { lastBrowseAt: now });
}

/** Re-registers the hooks only when the wanted origins changed (states change often). */
let registeredOrigins: string | null = null;

async function syncRegistrations(
  rules: SiteRule[],
  states: Record<string, SiteState>,
): Promise<void> {
  const origins = hookOrigins(rules, states);
  const key = origins.join(" ");
  if (key === registeredOrigins) return;
  registeredOrigins = key;
  await syncHookRegistrations(chrome.scripting, origins).catch((error: unknown) => {
    registeredOrigins = null;
    console.warn(`[nmc] site hook registration failed: ${String(error)}`);
  });
}

/** Permission flags from what the browser grants now, then the hook registrations. */
export async function syncSites(): Promise<void> {
  const rules = await loadSiteRules(local);
  const states = await loadSiteStates(local);
  for (const rule of rules) {
    const granted = await hasSitePermission(chrome.permissions, rule);
    if (stateOf(states, rule.id).permissionGranted !== granted) {
      states[rule.id] = await updateSiteState(local, rule.id, { permissionGranted: granted });
    }
  }
  await syncRegistrations(rules, states);
}

/**
 * Collects every enabled, permitted custom site in parallel (each with
 * its own time limit); items go out as `feed-batch` on the current
 * session. Never rejects: a failing site only shows in its outcome.
 */
export async function collectSitesForCollection(
  sendBatch: (batch: FeedBatch) => boolean,
): Promise<SiteCollectOutcome[]> {
  try {
    const rules = await loadSiteRules(local);
    const states = await loadSiteStates(local);
    return await runSites(rules, states, {
      collect: collectDeps,
      sendBatch,
      updateState: (id, change) => mutateSiteState(local, id, change),
      restoreRequestBuffer,
      now: () => new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[nmc] custom site collection failed: ${String(error)}`);
    return [];
  }
}

export interface SiteWorkerHooks {
  sendBatch(batch: FeedBatch): boolean;
}

/**
 * An extension page (Options, popup) by the sending document's URL — not
 * by `sender.tab`: Options is an `options_page`, so it always runs in a
 * tab. A content script (the picker) reports the web page's URL instead.
 */
export function fromExtensionPage(
  sender: Pick<chrome.runtime.MessageSender, "id" | "url">,
  extensionRoot: string,
): boolean {
  return sender.url?.startsWith(extensionRoot) === true;
}

/** Extension pages, or the picker in the tab it was opened in. */
async function allowed(
  message: SiteWorkerMessage,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  if (sender.id !== chrome.runtime.id) return false;
  const fromPage = fromExtensionPage(sender, chrome.runtime.getURL(""));
  const fromPicker = async (): Promise<boolean> =>
    !fromPage && sender.tab?.id !== undefined && (await pickerTabs()).includes(sender.tab.id);
  switch (message.kind) {
    case "site-picker-open":
    case "site-collect-visible":
      return fromPage;
    case "site-probe":
      return fromPage || (await fromPicker());
    default:
      return fromPicker();
  }
}

async function handle(
  message: SiteWorkerMessage,
  sender: chrome.runtime.MessageSender,
  hooks: SiteWorkerHooks,
): Promise<unknown> {
  if (!(await allowed(message, sender))) return { ok: false, message: "not allowed" };
  switch (message.kind) {
    case "site-picker-open":
      await openPicker(message.target);
      return { ok: true };
    case "site-picker-save":
      return saveFromPicker(message.rule, message.foundCount);
    case "site-probe": {
      const parsed = SiteRuleSchema.safeParse(message.rule);
      return parsed.success
        ? probeRule(parsed.data)
        : { ok: false, count: 0, message: "invalid rule" };
    }
    case "site-picker-hook": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["site-hook.js"],
        world: "MAIN",
      });
      return { ok: true };
    }
    case "site-open-options":
      if (sender.tab?.id !== undefined) await setPickerTab(sender.tab.id, false);
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case "site-collect-visible":
      return collectVisible(message.id, hooks.sendBatch);
  }
}

/** Listeners of the Sites feature; call once from the service worker. */
export function installSiteWorker(hooks: SiteWorkerHooks): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (isSiteRequestCaptureMessage(message)) {
      if (sender.id !== chrome.runtime.id || !sender.tab) return;
      void onRequestCapture(
        message.siteId,
        message.url,
        message.bodyText,
        sender.tab.url,
      ).catch((error: unknown) =>
        console.warn(`[nmc] "more" capture failed: ${String(error)}`),
      );
      return;
    }
    if (!isSiteWorkerMessage(message)) return;
    handle(message, sender, hooks).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, message: String(error) }),
    );
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => void setPickerTab(tabId, false));

  chrome.permissions.onRemoved.addListener((removed) => {
    void (async () => {
      const rules = await loadSiteRules(local);
      for (const rule of rulesAffectedBy(rules, removed.origins ?? [])) {
        await updateSiteState(local, rule.id, { permissionGranted: false });
      }
      await syncSites();
    })();
  });
  chrome.permissions.onAdded.addListener(() => void syncSites());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !touchesSites(Object.keys(changes))) return;
    void (async () => {
      await syncRegistrations(await loadSiteRules(local), await loadSiteStates(local));
    })();
  });

  void migrateLegacySiteStates(local)
    .then(syncSites)
    .catch(() => undefined);
}
