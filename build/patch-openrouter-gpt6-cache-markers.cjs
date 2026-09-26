// Salem AI (Claude, 2026-09-26): prompt-cache markers for GPT-6 models on OpenRouter.
//
// GPT-6 via OpenRouter bills cache writes (1.25x input) and, without explicit breakpoints, only
// the system prompt is reused: every Jarvis call re-wrote the whole conversation as a cache write
// (26 Sep: 96% of the day's spend). A direct test through OpenRouter showed near-full reuse
// (99.8%) with Anthropic-style cache_control markers on the system prompt, the last tool and the
// latest real message. OpenClaw already applies exactly that layout ("anthropic" cache-control
// format) — but detects it only for anthropic/* models on OpenRouter. This adds openai/gpt-6*
// on OpenRouter routes to that detection. Fails the build if the upstream snippet changed.
const fs = require("fs");

const file = "packages/ai/src/transports/openai-completions-compat.ts";
const anchor = '      (modelId?.toLowerCase().startsWith("anthropic/") === true &&\n';
const addition =
  '      (/^openai\\/gpt-6(?:[.\\-/]|$)/.test(modelId?.toLowerCase() ?? "") &&\n' +
  '        (endpointClass === "openrouter" || (isDefaultRoute && provider === "openrouter"))) ||\n';

let src = fs.readFileSync(file, "utf8");
if (src.includes('openai\\/gpt-6(?:')) {
  console.log("openrouter gpt-6 cache-marker patch already applied");
  process.exit(0);
}
const at = src.indexOf(anchor);
if (at < 0 || src.indexOf(anchor, at + 1) >= 0) {
  throw new Error("openrouter gpt-6 cache-marker patch: anchor not found exactly once — upstream changed");
}
// The anchor must sit inside the cacheControlFormat detection.
const context = src.slice(Math.max(0, at - 200), at);
if (!context.includes("cacheControlFormat:")) {
  throw new Error("openrouter gpt-6 cache-marker patch: anchor is not in the cacheControlFormat detection");
}
src = src.slice(0, at) + addition + src.slice(at);
fs.writeFileSync(file, src);
console.log("openrouter gpt-6 cache-marker patch applied");
