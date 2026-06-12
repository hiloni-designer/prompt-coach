# Prompt Coach

A token-saving prompt rewriter. It rewrites what you type into an AI chat box so it's clearer and uses fewer tokens — and shows you why.

- **Chrome extension** — adds a "✦ Coach" button on ChatGPT, Claude, Gemini, Perplexity, Copilot, and Grok. Source in [`extension/`](extension/).
- **Privacy policy** — https://hiloni-designer.github.io/prompt-coach/privacy.html

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode.
2. **Load unpacked** → select the `extension/` folder.
3. Open the popup, pick a provider (OpenAI / Anthropic key, or local Ollama), and save.

See [`extension/README.md`](extension/README.md) for full setup, providers, and features.

## Bring your own model

No backend. Works with your own OpenAI or Anthropic API key, or a fully local & free Ollama model — your data goes only to the provider you choose.
