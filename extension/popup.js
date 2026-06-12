const els = {
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  apiKey: document.getElementById("apiKey"),
  ollamaUrl: document.getElementById("ollamaUrl"),
  useHistory: document.getElementById("useHistory"),
  fastMode: document.getElementById("fastMode"),
  keyField: document.getElementById("key-field"),
  ollamaField: document.getElementById("ollama-field"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  status: document.getElementById("status"),
};

function syncFields() {
  const isOllama = els.provider.value === "ollama";
  els.keyField.hidden = isOllama;
  els.ollamaField.hidden = !isOllama;
}

// Load saved settings.
chrome.storage.sync.get(
  { provider: "openai", model: "", apiKey: "", ollamaUrl: "http://localhost:11434", useHistory: false, fastMode: true },
  (cfg) => {
    els.provider.value = cfg.provider;
    els.model.value = cfg.model;
    els.apiKey.value = cfg.apiKey;
    els.ollamaUrl.value = cfg.ollamaUrl;
    els.useHistory.checked = cfg.useHistory;
    els.fastMode.checked = cfg.fastMode;
    syncFields();
  }
);

els.provider.addEventListener("change", syncFields);

function currentSettings() {
  return {
    provider: els.provider.value,
    model: els.model.value.trim(),
    apiKey: els.apiKey.value.trim(),
    ollamaUrl: els.ollamaUrl.value.trim() || "http://localhost:11434",
    useHistory: els.useHistory.checked,
    fastMode: els.fastMode.checked,
  };
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

els.save.addEventListener("click", () => {
  chrome.storage.sync.set(currentSettings(), () => {
    setStatus("Saved.", "ok");
    setTimeout(() => setStatus(""), 1500);
  });
});

els.test.addEventListener("click", () => {
  // Save first so the background worker tests the values now in the form.
  chrome.storage.sync.set(currentSettings(), () => {
    setStatus("Testing…");
    els.test.disabled = true;
    chrome.runtime.sendMessage({ type: "COACH_TEST" }, (resp) => {
      els.test.disabled = false;
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, "err");
        return;
      }
      if (resp?.ok) setStatus("✓ " + resp.info, "ok");
      else setStatus("✗ " + (resp?.error || "Test failed."), "err");
    });
  });
});
