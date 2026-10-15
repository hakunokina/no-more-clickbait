const openOptions = document.querySelector<HTMLButtonElement>("#open-options");
openOptions?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
