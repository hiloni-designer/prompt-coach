// Injects a "Coach" button near the prompt box on ChatGPT / Claude / Gemini,
// reads the current draft, asks the background worker to rewrite it, and shows
// a panel with the rewrite + reasoning. The user chooses to apply it.

(function () {
  const HOST = location.hostname;

  // Per-site selectors for the editable prompt box.
  const SITES = {
    "chatgpt.com": {
      input: "#prompt-textarea, div[contenteditable='true']",
      message: "[data-message-author-role]",
      role: (el) => el.getAttribute("data-message-author-role"),
    },
    "chat.openai.com": {
      input: "#prompt-textarea, textarea",
      message: "[data-message-author-role]",
      role: (el) => el.getAttribute("data-message-author-role"),
    },
    "claude.ai": {
      input: "div[contenteditable='true'].ProseMirror, div[contenteditable='true']",
      message: "[data-testid*='message'], .font-claude-message",
      role: (el) => (el.className && el.className.includes("claude") ? "assistant" : "user"),
    },
    "gemini.google.com": {
      input: "div.ql-editor[contenteditable='true'], rich-textarea div[contenteditable='true']",
      message: "user-query, model-response",
      role: (el) => (el.tagName.toLowerCase() === "user-query" ? "user" : "assistant"),
    },
    "perplexity.ai": {
      input: "textarea[placeholder], div[contenteditable='true']",
      message: "[class*='prose'], [data-testid*='answer']",
      role: () => "assistant",
    },
    "copilot.microsoft.com": {
      input: "textarea#userInput, textarea, div[contenteditable='true']",
      message: "[data-content='ai-message'], [data-content='user-message']",
      role: (el) => (el.getAttribute("data-content") === "user-message" ? "user" : "assistant"),
    },
    "grok.com": {
      input: "textarea, div[contenteditable='true']",
      message: "[class*='message-bubble'], [class*='response']",
      role: () => "assistant",
    },
  };

  const config = Object.entries(SITES).find(([d]) => HOST.includes(d))?.[1];
  if (!config) return;

  let panel = null;
  // History of rewrites for the current draft, plus which one is showing.
  let history = [];
  let historyIndex = -1;
  let historyDraft = "";
  let chatContext = ""; // scraped chat history for the current run (understanding-only)
  let elapsedTimer = null;
  let elapsedStart = 0;

  function startElapsed() {
    elapsedStart = Date.now();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const el = panel && panel.querySelector("#pc-elapsed");
      if (el) el.textContent = `${Math.round((Date.now() - elapsedStart) / 1000)}s`;
    }, 500);
  }

  function stopElapsed() {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  function getInputEl() {
    // Try the site-specific selector first, then resilient fallbacks. Claude
    // (and others) change their DOM often, so we don't rely on one selector.
    const candidates = [
      config.input,
      "div[contenteditable='true'].ProseMirror",
      "div.ProseMirror[contenteditable='true']",
      "[aria-label*='prompt' i][contenteditable='true']",
      "[aria-label*='message' i][contenteditable='true']",
      "div[contenteditable='true']",
      "textarea",
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      // Prefer a visible element (Claude renders hidden editors during transitions).
      for (const el of els) {
        if (el.offsetParent !== null || el.getClientRects().length) return el;
      }
      if (els[0]) return els[0];
    }
    return null;
  }

  function readDraft(el) {
    if (!el) return "";
    return (el.value ?? el.innerText ?? "").trim();
  }

  function countTokens(text) {
    const t = window.PromptCoachTokens;
    return t ? t.estimateTokens(text) : 0;
  }

  // Scrapes the last few visible chat turns as plain text, for understanding-only
  // context. Returns "" if unavailable. Capped so it never bloats the Coach call.
  function scrapeHistory(maxTurns = 6, maxChars = 4000) {
    if (!config.message) return "";
    const nodes = Array.from(document.querySelectorAll(config.message));
    if (!nodes.length) return "";
    const recent = nodes.slice(-maxTurns);
    const lines = recent
      .map((el) => {
        const role = (config.role && config.role(el)) || "user";
        const text = (el.innerText || "").trim().replace(/\s+\n/g, "\n");
        if (!text) return "";
        return `${role === "assistant" ? "Assistant" : "User"}: ${text}`;
      })
      .filter(Boolean);
    let out = lines.join("\n\n");
    if (out.length > maxChars) out = "…\n" + out.slice(out.length - maxChars); // keep the most recent
    return out;
  }

  function writeDraft(el, text) {
    if (!el) return;
    el.focus();
    if ("value" in el && el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable: replace content and fire input so the app's state updates.
      el.innerText = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }

  function ensureButton() {
    if (document.getElementById("pc-coach-btn")) return;
    // Attach the floating button unconditionally — it's position:fixed and
    // doesn't need the editor until the user clicks. (Gating on the editor
    // meant a stale selector hid the button entirely, e.g. on claude.ai.)
    const btn = document.createElement("button");
    btn.id = "pc-coach-btn";
    btn.type = "button";
    btn.textContent = "✦ Coach";
    btn.title = "Improve this prompt (Prompt Coach)";
    btn.addEventListener("click", onCoachClick);
    document.body.appendChild(btn);
  }

  async function onCoachClick() {
    const input = getInputEl();
    if (!input) {
      showPanel({ error: "Couldn't find the prompt box on this page. Click into the chat input once, then try again. (If this keeps happening, the site's layout may have changed.)" });
      return;
    }
    const draft = readDraft(input);
    if (!draft) {
      showPanel({ error: "Type a prompt in the chat box first, then click Coach." });
      return;
    }
    // Fresh run on a (possibly new) draft resets history.
    history = [];
    historyIndex = -1;
    historyDraft = draft;
    // Read the opt-in setting, scrape chat history if enabled, then run.
    chrome.storage.sync.get({ useHistory: false }, (cfg) => {
      chatContext = cfg.useHistory ? scrapeHistory() : "";
      requestRewrite(draft, null);
    });
  }

  // Runs a rewrite for `draft`. Streams the rewrite text live via a port, then
  // finalizes with the full structured result. Falls back to an error panel on failure.
  function requestRewrite(draft, avoid) {
    showPanel({ loading: true });
    startElapsed();
    let settled = false;
    let gotFirstToken = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      stopElapsed();
      try { port.disconnect(); } catch {}
      clearTimeout(timer);
      showPanel(state);
    };
    const timer = setTimeout(() => {
      finish({
        error:
          "Timed out after 90s. If you're on Ollama, the model may still be loading into memory (try again — the second run is faster), or the extension/page needs a reload after the latest update.",
      });
    }, 90000);

    const port = chrome.runtime.connect({ name: "coach-stream" });
    port.onMessage.addListener((evt) => {
      if (evt.type === "delta") {
        gotFirstToken = true;
        showStreaming(evt.rewrite);
      } else if (evt.type === "done") {
        history.push(evt.data);
        historyIndex = history.length - 1;
        finish({ data: evt.data, draft });
      } else if (evt.type === "error") {
        finish({ error: evt.error || "Something went wrong." });
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) finish({ error: chrome.runtime.lastError?.message || "Connection closed before completion." });
    });
    port.postMessage({
      type: "COACH_REWRITE_STREAM",
      prompt: draft,
      originalTokens: countTokens(draft),
      avoid: avoid || "",
      historyContext: chatContext || "",
    });
  }

  // Renders the rewrite as it streams in (before the full result is ready).
  function showStreaming(text) {
    if (!panel || panel.dataset.mode !== "stream") {
      if (panel) panel.remove();
      panel = document.createElement("div");
      panel.id = "pc-coach-panel";
      panel.dataset.mode = "stream";
      panel.innerHTML = `<div class="pc-head">Prompt Coach<span class="pc-x">×</span></div>
        <div class="pc-body">
          <label class="pc-label">Rewriting… <span id="pc-elapsed" class="pc-token-src">0s</span></label>
          <textarea id="pc-stream" rows="6" readonly></textarea>
        </div>`;
      document.body.appendChild(panel);
      panel.querySelector(".pc-x")?.addEventListener("click", () => { stopElapsed(); panel.remove(); });
    }
    const ta = panel.querySelector("#pc-stream");
    if (ta) {
      ta.value = text;
      ta.scrollTop = ta.scrollHeight;
    }
  }

  function showPanel(state) {
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = "pc-coach-panel";

    if (state.loading) {
      panel.innerHTML = `<div class="pc-head">Prompt Coach<span class="pc-x">×</span></div>
        <div class="pc-body"><div class="pc-spinner"></div> Rewriting your prompt… <span id="pc-elapsed" class="pc-token-src">0s</span></div>`;
    } else if (state.error) {
      panel.innerHTML = `<div class="pc-head">Prompt Coach<span class="pc-x">×</span></div>
        <div class="pc-body pc-error">${escapeHtml(state.error)}</div>`;
    } else {
      const d = state.data;
      panel.innerHTML = `
        <div class="pc-head">Prompt Coach<span class="pc-x">×</span></div>
        <div class="pc-body">
          <label class="pc-label">Rewritten prompt</label>
          <textarea id="pc-rewrite" rows="6">${escapeHtml(d.rewrite)}</textarea>
          <div class="pc-actions">
            <button id="pc-apply">Apply to chat</button>
            <button id="pc-regen" class="pc-secondary" title="Generate a different rewrite">↻ Regenerate</button>
            <button id="pc-copy" class="pc-secondary">Copy</button>
          </div>
          ${historyNav()}
          ${chatContext ? `<div class="pc-ctx">📎 Used recent chat history to sharpen this (not added to your prompt).</div>` : ""}
          ${listBlock("Why it's better", d.why)}
          ${listBlock("Clarifying questions", d.questions)}
          ${listBlock("Assumptions", d.assumptions)}
          ${tokenBadge(state.draft, d.rewrite)}
        </div>`;
    }

    document.body.appendChild(panel);
    panel.querySelector(".pc-x")?.addEventListener("click", () => {
      stopElapsed();
      panel.remove();
    });

    if (state.data) {
      panel.querySelector("#pc-apply")?.addEventListener("click", () => {
        const text = panel.querySelector("#pc-rewrite").value;
        writeDraft(getInputEl(), text);
        panel.remove();
      });
      panel.querySelector("#pc-copy")?.addEventListener("click", () => {
        navigator.clipboard.writeText(panel.querySelector("#pc-rewrite").value);
      });
      panel.querySelector("#pc-regen")?.addEventListener("click", () => {
        // Re-run on the same original draft, asking the model to avoid the
        // current rewrite so the user gets a genuinely different option.
        requestRewrite(state.draft, state.data.rewrite);
      });
      panel.querySelector("#pc-hist-prev")?.addEventListener("click", () => {
        if (historyIndex > 0) {
          historyIndex--;
          showPanel({ data: history[historyIndex], draft: historyDraft });
        }
      });
      panel.querySelector("#pc-hist-next")?.addEventListener("click", () => {
        if (historyIndex < history.length - 1) {
          historyIndex++;
          showPanel({ data: history[historyIndex], draft: historyDraft });
        }
      });
      // Recompute the token estimate live as the user edits the rewrite.
      panel.querySelector("#pc-rewrite")?.addEventListener("input", (e) => {
        refreshTokenBadge(state.draft, e.target.value);
      });
    }
  }

  function listBlock(title, items) {
    if (!items || items.length === 0) return "";
    const lis = items.map((i) => `<li>${escapeHtml(i)}</li>`).join("");
    return `<label class="pc-label">${title}</label><ul class="pc-list">${lis}</ul>`;
  }

  // Prev/next navigator across regenerated versions. Hidden for a single entry.
  function historyNav() {
    if (history.length < 2) return "";
    const prevDisabled = historyIndex <= 0 ? "disabled" : "";
    const nextDisabled = historyIndex >= history.length - 1 ? "disabled" : "";
    return `<div class="pc-hist">
      <button id="pc-hist-prev" class="pc-hist-btn" ${prevDisabled} title="Previous version">‹</button>
      <span class="pc-hist-label">Version ${historyIndex + 1} of ${history.length}</span>
      <button id="pc-hist-next" class="pc-hist-btn" ${nextDisabled} title="Next version">›</button>
    </div>`;
  }

  function tokenBadge(beforeText, afterText) {
    const t = window.PromptCoachTokens;
    if (!t) return "";
    const { before, after, saved, pct } = t.estimateSavings(beforeText, afterText);
    const positive = saved > 0;
    const cls = positive ? "pc-token" : "pc-token pc-token-neg";
    const verb = positive
      ? `−${saved} tokens (${pct}% less)`
      : saved === 0
      ? "same length"
      : `+${-saved} tokens longer — original was leaner`;
    const label = t.exact ? `exact · ${t.encoding}` : "estimate";
    return `<div class="${cls}" id="pc-token">
      <span>⚡ <strong id="pc-tok-before">${before}</strong> → <strong id="pc-tok-after">${after}</strong> tokens <span class="pc-token-src">${label}</span></span>
      <span class="pc-token-delta" id="pc-tok-delta">${verb}</span>
    </div>`;
  }

  function refreshTokenBadge(beforeText, afterText) {
    const t = window.PromptCoachTokens;
    if (!t || !panel) return;
    const badge = panel.querySelector("#pc-token");
    if (!badge) return;
    const { before, after, saved, pct } = t.estimateSavings(beforeText, afterText);
    const positive = saved > 0;
    panel.querySelector("#pc-tok-before").textContent = before;
    panel.querySelector("#pc-tok-after").textContent = after;
    panel.querySelector("#pc-tok-delta").textContent = positive
      ? `−${saved} tokens (${pct}% less)`
      : saved === 0
      ? "same length"
      : `+${-saved} tokens longer — original was leaner`;
    badge.classList.toggle("pc-token-neg", !positive && saved !== 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // The chat apps re-render constantly, so keep trying to (re)attach the button.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Interval safety net in case an SPA swaps out document.body entirely.
  setInterval(ensureButton, 1500);
  ensureButton();
})();
