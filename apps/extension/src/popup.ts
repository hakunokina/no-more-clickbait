import { setUiLang, watchUiLang } from "./i18n.js";
import { localizePage } from "./i18n-dom.js";
import { bindModeBControls } from "./mode-b-view.js";

// A language change applies at once: the static texts here, and the
// Mode B controls re-render on the same storage change (after this).
await watchUiLang((lang) => {
  setUiLang(lang);
  localizePage(document);
});
localizePage(document);

const openOptions = document.querySelector<HTMLButtonElement>("#open-options");
openOptions?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

const modeBButton = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
if (modeBButton && modeBStatus) bindModeBControls({ button: modeBButton, status: modeBStatus });
