const DEFAULTS = {
  enabled: true,
  showToast: true
};

const enabled = document.getElementById("enabled");
const showToast = document.getElementById("showToast");

chrome.storage.sync.get(DEFAULTS, (settings) => {
  enabled.checked = Boolean(settings.enabled);
  showToast.checked = Boolean(settings.showToast);
});

enabled.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabled.checked });
});

showToast.addEventListener("change", () => {
  chrome.storage.sync.set({ showToast: showToast.checked });
});
