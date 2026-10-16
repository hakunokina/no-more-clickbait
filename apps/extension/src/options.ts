import {
  ModeBPacingSchema,
  ModeBSurfaceSchema,
  SettingsStampSchema,
  type Settings,
  type SettingsStamp,
} from "@nmc/core";
import { t, uiLang, watchUiLang } from "./i18n.js";
import { localizePage } from "./i18n-dom.js";
import { createLangReloader, createStatusLine } from "./lang-reload.js";
import { bindModeBControls, requestModeBPermissions } from "./mode-b-view.js";
import {
  fillPipelineFields,
  readPipelineFields,
  reflectVerifyEnabled,
  renderPipelineFields,
  showPipelineErrors,
} from "./pipeline-fields.js";
import {
  applyPipelineSettings,
  defaultSyncedSettings,
  readPipelineForm,
} from "./pipeline-form.js";
import { loadSettings, saveSettings, SETTINGS_STAMP_KEY } from "./settings.js";
import { createSettingsSyncer, describeSyncResult, sendNativeOnce } from "./settings-sync.js";
import { SitesSection } from "./sites/sites-section.js";
import { fetchText } from "./sites/fetch-text.js";
import { SITE_NEW_RULE_KEY, touchesSites } from "./sites/storage-keys.js";

const modeB = document.querySelector<HTMLInputElement>("#mode-b");
const modeBStrategy = document.querySelector<HTMLSelectElement>("#mode-b-strategy");
const modeBPacing = document.querySelector<HTMLSelectElement>("#mode-b-pacing");
const modeBRun = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
const modeBLastRun = document.querySelector<HTMLElement>("#mode-b-last-run");
const devCapture = document.querySelector<HTMLInputElement>("#dev-capture");
const pipelineFields = document.querySelector<HTMLElement>("#pipeline-fields");
const pipelineDefaults = document.querySelector<HTMLButtonElement>("#pipeline-defaults");
const status = document.querySelector<HTMLElement>("#status");
const syncStatus = document.querySelector<HTMLElement>("#sync-status");
const form = document.querySelector<HTMLFormElement>("#settings-form");
/** The form holds edits not saved yet; a desktop change must not wipe them. */
let dirty = false;
let sitesSection: SitesSection | undefined;

const statusLine = createStatusLine(status, () => t("optLangPending"));
// The page stays in the language it opened in; a new one comes with a reload.
const langReloader = createLangReloader({
  pageLang: uiLang,
  busy: () => dirty || (sitesSection?.busy() ?? false),
  reload: () => location.reload(),
  notePending: (pending) => statusLine.notePending(pending),
});

await watchUiLang((lang) => langReloader.changed(lang));
localizePage(document);

async function init(): Promise<void> {
  if (
    !modeB ||
    !modeBStrategy ||
    !modeBPacing ||
    !modeBRun ||
    !modeBStatus ||
    !devCapture ||
    !pipelineFields ||
    !pipelineDefaults ||
    !form ||
    !status ||
    !syncStatus
  ) {
    return;
  }
  let settings = await loadSettings();
  const controls = renderPipelineFields(pipelineFields);
  const fill = (values: Settings): void => {
    modeB.checked = values.modeBEnabled;
    modeBStrategy.value = values.modeBStrategy;
    modeBPacing.value = values.modeBPacing;
    devCapture.checked = values.devCaptureEnabled;
    fillPipelineFields(controls, values);
  };
  fill(settings);
  form.addEventListener("input", () => {
    dirty = true;
  });
  // A change made in the desktop app shows up here at once.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const stamp = SettingsStampSchema.safeParse(changes[SETTINGS_STAMP_KEY]?.newValue);
    if (areaName !== "local" || !stamp.success || stamp.data.source !== "desktop") return;
    void loadSettings().then((loaded) => {
      settings = loaded;
      syncStatus.textContent = "";
      if (dirty) {
        statusLine.say(t("optDesktopChangedDirty"));
        return;
      }
      fill(loaded);
      statusLine.say(t("optDesktopUpdated"));
    });
  });
  controls.get("verifyEnabled")?.input.addEventListener("change", () => {
    reflectVerifyEnabled(controls);
  });
  pipelineDefaults.addEventListener("click", () => {
    fillPipelineFields(controls, defaultSyncedSettings());
    dirty = true;
    statusLine.say(t("optDefaultsRestored"));
  });
  bindModeBControls({
    button: modeBRun,
    status: modeBStatus,
    lastRun: modeBLastRun,
    // A run reads the saved settings: a pace picked but not saved would not apply.
    startBlocked: () => (dirty ? t("modeBSaveFirst") : null),
  });
  const syncSettings = createSettingsSyncer(sendNativeOnce);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pipeline = readPipelineForm(readPipelineFields(controls), settings);
    showPipelineErrors(controls, pipeline);
    if (!pipeline.ok) {
      statusLine.say(t("optNotSaved"));
      syncStatus.textContent = "";
      return;
    }
    // Shows the kept value in a disabled field whose entry was ignored.
    fillPipelineFields(controls, pipeline.settings);
    // Asked while the click still counts as a user gesture.
    const permission = modeB.checked ? requestModeBPermissions() : Promise.resolve(true);
    void (async () => {
      let stamp: SettingsStamp;
      const granted = await permission;
      if (!granted) modeB.checked = false;
      const strategy = ModeBSurfaceSchema.safeParse(modeBStrategy.value);
      const pacing = ModeBPacingSchema.safeParse(modeBPacing.value);
      try {
        settings = {
          ...applyPipelineSettings(settings, pipeline.settings),
          modeBEnabled: modeB.checked,
          modeBStrategy: strategy.success ? strategy.data : settings.modeBStrategy,
          modeBPacing: pacing.success ? pacing.data : settings.modeBPacing,
          devCaptureEnabled: devCapture.checked,
        };
        stamp = { updatedAt: new Date().toISOString(), source: "extension" };
        await saveSettings(settings, stamp);
        dirty = false;
        statusLine.say(granted ? t("optSaved") : t("optSavedNoAlarms"));
      } catch {
        statusLine.say(t("optSaveFailed"));
        return;
      }
      syncStatus.textContent = "";
      const synced = await syncSettings(settings, stamp);
      syncStatus.textContent = describeSyncResult(synced);
      langReloader.settle();
    })();
  });
}

void init();

// --- Sites (custom site rules) ------------------------------------------

async function initSites(): Promise<void> {
  const container = document.querySelector<HTMLElement>("#sites");
  if (!container) return;
  const sites = new SitesSection(container, {
    doc: document,
    local: chrome.storage.local,
    session: chrome.storage.session,
    permissions: chrome.permissions,
    send: (message) => chrome.runtime.sendMessage(message),
    fetchText,
    now: () => new Date().toISOString(),
    download: (fileName, text) => {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    copy: (text) => navigator.clipboard.writeText(text),
    onSettle: () => langReloader.settle(),
  });
  sitesSection = sites;
  await sites.refresh();
  // Closing Options inside a delete's Undo window still gives the permission back.
  window.addEventListener("pagehide", () => sites.finishPendingNow());
  // The picker saves through the worker; the list follows storage.
  chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes);
    if (
      (area === "local" && touchesSites(keys)) ||
      (area === "session" &&
        keys.includes(SITE_NEW_RULE_KEY) &&
        changes[SITE_NEW_RULE_KEY]?.newValue)
    ) {
      void sites.refresh();
    }
  });
  if (location.hash === "#sites") container.scrollIntoView();
}

void initSites();
