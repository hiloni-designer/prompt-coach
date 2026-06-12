// Service worker: receives rewrite requests from the content script,
// calls the configured LLM provider with the user's own API key, and
// returns structured coaching JSON.

import { COACH_SYSTEM_PROMPT, COACH_SYSTEM_PROMPT_FAST, buildUserMessage } from "./coach-prompt.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "COACH_REWRITE") {
    handleRewrite(msg.prompt, msg.originalTokens, msg.avoid, msg.historyContext)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the message channel open for async response
  }
  if (msg?.type === "COACH_TEST") {
    testConnection()
      .then((info) => sendResponse({ ok: true, info }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

// Streaming path: content script opens a long-lived port so we can push the
// rewrite as it's generated (feels far faster than waiting for the full JSON).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "coach-stream") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "COACH_REWRITE_STREAM") return;
    streamRewrite(msg, (evt) => {
      try {
        port.postMessage(evt);
      } catch {
        /* port closed */
      }
    }).catch((err) => {
      try {
        port.postMessage({ type: "error", error: String(err?.message || err) });
      } catch {
        /* port closed */
      }
    });
  });
});

// Extracts the value of the "rewrite" JSON field from a partial/incomplete
// string, so we can display it as it streams in. Returns "" until it appears.
function extractPartialRewrite(buf) {
  const key = buf.indexOf('"rewrite"');
  if (key === -1) return "";
  const colon = buf.indexOf(":", key);
  if (colon === -1) return "";
  const firstQuote = buf.indexOf('"', colon + 1);
  if (firstQuote === -1) return "";
  let out = "";
  for (let i = firstQuote + 1; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\\") {
      const next = buf[i + 1];
      if (next === undefined) break; // escape split across chunks
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
      continue;
    }
    if (c === '"') break; // end of the rewrite string
    out += c;
  }
  return out;
}

async function streamRewrite(msg, send) {
  const { prompt, originalTokens, avoid, historyContext } = msg;
  const { provider, apiKey, model, ollamaUrl, fastMode } = await chrome.storage.sync.get({
    provider: "openai",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    fastMode: true,
  });
  const system = fastMode ? COACH_SYSTEM_PROMPT_FAST : COACH_SYSTEM_PROMPT;
  const maxOut = fastMode ? 256 : 1024;
  const userMsg = buildUserMessage(prompt, originalTokens, avoid, historyContext);

  let url, headers, body, pickDelta;
  if (provider === "ollama") {
    url = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "") + "/api/chat";
    headers = { "Content-Type": "application/json" };
    body = {
      model: model || "llama3.1",
      stream: true,
      format: "json",
      keep_alive: "30m",
      options: { temperature: avoid ? 0.8 : 0.3, num_predict: maxOut },
      messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
    };
    pickDelta = (o) => o?.message?.content || "";
  } else if (provider === "anthropic") {
    if (!apiKey) throw new Error("No API key set. Open the Prompt Coach extension settings to add one.");
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    body = {
      model: model || "claude-3-5-haiku-latest",
      max_tokens: maxOut,
      temperature: avoid ? 0.8 : 0.3,
      stream: true,
      system,
      messages: [{ role: "user", content: userMsg }],
    };
    pickDelta = (o) => (o?.type === "content_block_delta" ? o.delta?.text || "" : "");
  } else {
    if (!apiKey) throw new Error("No API key set. Open the Prompt Coach extension settings to add one.");
    url = "https://api.openai.com/v1/chat/completions";
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    body = {
      model: model || "gpt-4o-mini",
      temperature: avoid ? 0.8 : 0.3,
      max_tokens: maxOut,
      response_format: { type: "json_object" },
      stream: true,
      messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
    };
    pickDelta = (o) => o?.choices?.[0]?.delta?.content || "";
  }

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    if (provider === "ollama") {
      throw new Error(`Could not reach Ollama at ${ollamaUrl}. Run \`ollama serve\` and \`ollama pull ${model || "llama3.1"}\`. (${e.message})`);
    }
    throw e;
  }
  if (provider === "ollama" && res.status === 403) {
    throw new Error("Ollama refused the request (403). Reload the extension at chrome://extensions. If it persists, update Chrome, or set OLLAMA_ORIGINS=* and restart the Ollama app.");
  }
  if (!res.ok) throw new Error(`${provider} error ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";       // accumulated model output (the JSON)
  let sseBuf = "";    // buffer for line-delimited stream framing
  let lastSent = "";

  const handleContent = (delta) => {
    if (!delta) return;
    raw += delta;
    const partial = extractPartialRewrite(raw);
    if (partial && partial !== lastSent) {
      lastSent = partial;
      send({ type: "delta", rewrite: partial });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    const lines = sseBuf.split("\n");
    sseBuf = lines.pop() || ""; // keep incomplete trailing line
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (provider === "ollama") {
        try { handleContent(pickDelta(JSON.parse(t))); } catch { /* partial */ }
      } else {
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try { handleContent(pickDelta(JSON.parse(payload))); } catch { /* partial */ }
      }
    }
  }

  // Parse the complete JSON for the full structured result.
  const data = parseCoachJson(raw);
  send({ type: "done", data });
}

async function handleRewrite(rawPrompt, originalTokens, avoid, historyContext) {
  const { provider, apiKey, model, ollamaUrl, fastMode } = await chrome.storage.sync.get({
    provider: "openai",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    fastMode: true,
  });
  const system = fastMode ? COACH_SYSTEM_PROMPT_FAST : COACH_SYSTEM_PROMPT;
  const maxOut = fastMode ? 256 : 1024;

  if (provider === "ollama") {
    const raw = await callOllama(ollamaUrl || "http://localhost:11434", model || "llama3.1", rawPrompt, originalTokens, avoid, historyContext, system, maxOut);
    return parseCoachJson(raw);
  }

  if (!apiKey) {
    throw new Error("No API key set. Open the Prompt Coach extension settings to add one.");
  }

  const raw =
    provider === "anthropic"
      ? await callAnthropic(apiKey, model || "claude-3-5-haiku-latest", rawPrompt, originalTokens, avoid, historyContext, system, maxOut)
      : await callOpenAI(apiKey, model || "gpt-4o-mini", rawPrompt, originalTokens, avoid, historyContext, system, maxOut);

  return parseCoachJson(raw);
}

async function callOpenAI(apiKey, model, rawPrompt, originalTokens, avoid, historyContext, system, maxOut) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: avoid ? 0.8 : 0.3,
      max_tokens: maxOut,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: buildUserMessage(rawPrompt, originalTokens, avoid, historyContext) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(apiKey, model, rawPrompt, originalTokens, avoid, historyContext, system, maxOut) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOut,
      temperature: avoid ? 0.8 : 0.3,
      system,
      messages: [{ role: "user", content: buildUserMessage(rawPrompt, originalTokens, avoid, historyContext) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content?.[0]?.text ?? "";
}

async function callOllama(baseUrl, model, rawPrompt, originalTokens, avoid, historyContext, system, maxOut) {
  const url = baseUrl.replace(/\/+$/, "") + "/api/chat";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json", // ask Ollama to constrain output to valid JSON
        keep_alive: "30m", // keep the model resident to avoid reload latency
        options: { temperature: avoid ? 0.8 : 0.3, num_predict: maxOut },
        messages: [
          { role: "system", content: system },
          { role: "user", content: buildUserMessage(rawPrompt, originalTokens, avoid, historyContext) },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach Ollama at ${baseUrl}. Make sure it's running (\`ollama serve\`) and the model is pulled (\`ollama pull ${model}\`). ` +
        `You may also need to allow this origin: set OLLAMA_ORIGINS to include the chat site. (${e.message})`
    );
  }
  if (res.status === 403) {
    throw new Error(
      "Ollama refused the request (403). Reload the extension at chrome://extensions. " +
        "If it persists, update Chrome, or set OLLAMA_ORIGINS=* and restart the Ollama app."
    );
  }
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.message?.content ?? "";
}

async function testConnection() {
  const { provider, apiKey, model, ollamaUrl } = await chrome.storage.sync.get({
    provider: "openai",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
  });

  if (provider === "ollama") {
    const base = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
    const wanted = model || "llama3.1";
    let res;
    try {
      res = await fetch(base + "/api/tags");
    } catch (e) {
      throw new Error(`Can't reach Ollama at ${base}. Run \`ollama serve\` first. (${e.message})`);
    }
    if (!res.ok) throw new Error(`Ollama responded ${res.status}.`);
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const has = names.some((n) => n === wanted || n.startsWith(wanted + ":"));
    if (!has) {
      throw new Error(`Connected, but model "${wanted}" isn't pulled. Run \`ollama pull ${wanted}\`. Available: ${names.join(", ") || "none"}.`);
    }
    return `Ollama OK — "${wanted}" is ready.`;
  }

  if (!apiKey) throw new Error("No API key set.");

  if (provider === "anthropic") {
    const m = model || "claude-3-5-haiku-latest";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: m, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    if (res.status === 401) throw new Error("Invalid API key (401).");
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    return `Anthropic OK — key valid, "${m}" reachable.`;
  }

  // OpenAI
  const m = model || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: m, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  });
  if (res.status === 401) throw new Error("Invalid API key (401).");
  if (res.status === 404) throw new Error(`Model "${m}" not found for this key.`);
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  return `OpenAI OK — key valid, "${m}" reachable.`;
}

function parseCoachJson(raw) {
  // Strip accidental code fences, then parse.
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    // Last resort: pull the first {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not parse model response.");
    data = JSON.parse(match[0]);
  }
  return {
    rewrite: data.rewrite || "",
    why: Array.isArray(data.why) ? data.why : [],
    questions: Array.isArray(data.questions) ? data.questions : [],
    assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
    tokenNote: data.tokenNote || "",
  };
}
