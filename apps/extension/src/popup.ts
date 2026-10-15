import { bindModeBControls } from "./mode-b-view.js";

const openOptions = document.querySelector<HTMLButtonElement>("#open-options");
openOptions?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

const modeBButton = document.querySelector<HTMLButtonElement>("#mode-b-run");
const modeBStatus = document.querySelector<HTMLElement>("#mode-b-status");
if (modeBButton && modeBStatus) bindModeBControls({ button: modeBButton, status: modeBStatus });
