// Bundled into ../tokens.js by esbuild. Exposes the same PromptCoachTokens
// API the content script expects, but backed by a real BPE tokenizer
// (js-tiktoken with the o200k_base ranks used by GPT-4o / gpt-4o-mini).

import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const enc = new Tiktoken(o200k_base);

function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return enc.encode(trimmed).length;
}

function estimateSavings(beforeText, afterText) {
  const before = estimateTokens(beforeText);
  const after = estimateTokens(afterText);
  const saved = before - after;
  const pct = before > 0 ? Math.round((saved / before) * 100) : 0;
  return { before, after, saved, pct };
}

// `exact: true` lets the UI label these as precise counts.
window.PromptCoachTokens = { estimateTokens, estimateSavings, exact: true, encoding: "o200k_base" };
