# Prompt Coach — Chrome Extension

Rewrites your prompt into a tight, professional, token-efficient version and teaches you why — right inside ChatGPT, Claude, and Gemini.

## How it works

1. A floating **✦ Coach** button appears on supported AI chat sites.
2. Type your prompt, click Coach.
3. The extension sends your draft to your chosen LLM (OpenAI or Anthropic) with the Prompt Coach system prompt.
4. A panel shows the **rewritten prompt**, **why it's better**, any **clarifying questions / assumptions**, and a **token note**.
5. Don't like the rewrite? Click **↻ Regenerate** for a different option (same original, higher variety, still within the token budget). Use the **‹ Version n of m ›** navigator to flip back to any earlier rewrite.
6. Click **Apply to chat** to drop the rewrite into the input box, or **Copy**.

### Streaming (perceived latency)

The rewrite **streams in live** — text starts appearing within ~250ms instead of after the full response. The content script opens a long-lived port to the service worker, which streams tokens from the provider (OpenAI, Anthropic, and Ollama all support SSE/NDJSON streaming) and incrementally extracts the `rewrite` field from the partial JSON. You see the prompt forming as it's written; the full panel (why/questions/token badge) renders once complete.

### Fast mode (latency)

A **"Fast mode"** toggle in the popup (on by default) cuts response time roughly in half. The main latency driver is the number of tokens the model *generates* — the why/questions/assumptions explanation, not the rewrite itself. Fast mode uses a leaner prompt that returns the same rewrite with terse 1-2 word explanations, roughly halving generated tokens (and so latency). Turn it off if you want richer coaching and don't mind the extra wait.

The Ollama path also sends `keep_alive: 30m` so the model stays resident between calls (avoids cold-load latency), and caps output length per request.

### Use chat history for context (optional)

There's a **"Use recent chat history for context"** toggle in the popup (off by default). When on, Coach reads the last few visible messages on the page and passes them to the rewriting model as *understanding-only* reference — so it can resolve vague references ("fix it like before") and skip questions you already answered earlier in the thread.

Important: history is **never copied into your rewritten prompt** — the chat AI already has the conversation, so restating it would waste tokens. History only makes the rewrite sharper (and often shorter). The trade-off: it adds tokens to the *Coach* call (the rewriting request), so leave it off for one-shot prompts. When it's used, the panel shows a 📎 note.

Note: attached *files* can't be read by the extension (they upload directly to the chat provider). Coach will reference them by name rather than guess at contents.

Bring-your-own-key: your API key is stored locally via `chrome.storage.sync` and only ever sent to the provider you pick. No third-party server.

### Providers

- **OpenAI** (default, `gpt-4o-mini`) — get a key at https://platform.openai.com/api-keys (requires billing).
- **Anthropic / Claude** (`claude-3-5-haiku-latest`) — get a key at https://console.anthropic.com/settings/keys (requires credits).
- **Ollama** (local, free, no key) — runs a model on your own machine. See setup below.

### Ollama setup (free, no API key)

1. Install Ollama: https://ollama.com/download
2. Pull a model: `ollama pull llama3.1` (or `qwen2.5`, `mistral`, etc.)
3. Make sure it's running: `ollama serve` (the desktop app starts this automatically).
4. In the extension popup, pick **Ollama**, set the model (e.g. `llama3.1`), and leave the URL as `http://localhost:11434`.

The extension automatically strips the `Origin` header on requests to localhost (via a `declarativeNetRequest` rule), so Ollama accepts them out of the box — **no `OLLAMA_ORIGINS` configuration needed.** If you ever still see a 403, reload the extension at `chrome://extensions`; on very old Chrome versions you can fall back to launching Ollama with `OLLAMA_ORIGINS=*`.

Quality scales with the local model — small models give rougher rewrites than gpt-4o-mini, but it's completely free and private (your prompts never leave your machine).

## Install (developer / unpacked)

1. Add icons (see below).
2. Go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the extension icon → enter your provider, model (optional), and API key → Save.
5. Click **Test connection** to confirm the key/model/URL work before relying on it.
6. Open ChatGPT / Claude / Gemini and use the **✦ Coach** button.

## Icons

This folder needs `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png`.
Any square PNG works. Quick way to generate placeholders with ImageMagick:

```bash
mkdir -p icons
for s in 16 48 128; do
  convert -size ${s}x${s} xc:'#6d5efc' -gravity center \
    -pointsize $((s/2)) -fill white -annotate 0 '✦' icons/icon${s}.png
done
```

## Supported sites

- chatgpt.com / chat.openai.com
- claude.ai
- gemini.google.com
- perplexity.ai
- copilot.microsoft.com
- grok.com

Selectors live in `content.js` (`SITES`). These apps change their DOM often; if the button stops attaching or "Apply" stops working, update the selectors there. The editor finder also has generic fallbacks, so the button still works on most chat UIs even if a site-specific selector drifts.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `coach-prompt.js` | Shared Prompt Coach system prompt + JSON contract |
| `background.js` | Service worker: calls OpenAI/Anthropic, parses coaching JSON |
| `content.js` | Injects the button + panel, reads/writes the prompt box |
| `content.css` | Styles for the injected UI |
| `tokens.js` | **Generated bundle** — real BPE tokenizer (js-tiktoken, o200k_base). Do not edit by hand |
| `build/` | Source + npm setup that produces `tokens.js` |
| `popup.html/.css/.js` | Settings (provider, model, API key) |

## Token counting

`tokens.js` is a bundled build of [js-tiktoken](https://www.npmjs.com/package/js-tiktoken) using the `o200k_base` ranks — the exact BPE encoder GPT-4o / gpt-4o-mini use, so counts match the OpenAI API. The panel labels the count `exact · o200k_base`.

Note: Anthropic (Claude) and local Ollama models use different tokenizers, so for those providers these counts are a close approximation, not exact. The bundle is ~2.2MB (the vocab table); that's the unavoidable cost of exact counting.

### Rebuilding `tokens.js`

```bash
cd build
npm install
npm run build   # writes ../tokens.js
```

Edit `build/entry.js` to change tokenizer behavior, then rebuild. Swap `o200k_base` for `cl100k_base` in `entry.js` if you target GPT-3.5/GPT-4 instead of GPT-4o.

## Privacy

- API key: stored locally, sent only to the selected provider.
- Prompt text: sent to the selected provider for rewriting. Nothing else is collected or transmitted.
- With **Ollama**, nothing leaves your machine at all — the prompt is rewritten by a local model, no key, no cloud.
