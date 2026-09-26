# OpenClaw Patch Inventory

This image is built from OpenClaw **v2026.9.6** at commit
`eb377ac59e6c9fd6c7705028034812becf00271b`. The Docker build verifies the
checkout SHA and fails if it differs.

The items below are local compatibility changes applied on top of that exact
upstream source. Review each one before changing the OpenClaw pin.

## 1. Browser dashboard-selector compatibility

**Location:** inline Node patch in `Dockerfile`

When an ordinary browser URL navigation also carries a dashboard selector, the
patch discards the dashboard selector and treats the request as normal managed
browser navigation. The patch requires the expected upstream source snippet
when the target file exists, so source drift fails the build rather than
silently applying a different edit.

**Removal condition:** upstream browser handling makes the compatibility shim
unnecessary.

## 2. WhatsApp cross-instance native delivery

**Location:** `build/patch-whatsapp-cross-instance.cjs`

This keeps the connection-owning WhatsApp channel runtime process-wide while
ordinary plugin runtime helpers remain instance-scoped. It addresses the case
where an agent turn cannot see the active WhatsApp Web listener even though the
channel is connected.

**Build gates:**
- `extensions/whatsapp/src/native-delivery.cross-instance.test.ts`
- `extensions/whatsapp/src/connection-controller.test.ts`

Both tests must pass before the image is built.

## 3. Prompt-cache markers for GPT-6 on OpenRouter

**Location:** `build/patch-openrouter-gpt6-cache-markers.cjs`

OpenClaw detects its Anthropic-style Chat Completions cache-control layout
(system prompt, last tool, latest real message; runtime-context carriers
skipped) only for `anthropic/*` models on OpenRouter. GPT-6 models on OpenRouter
bill cache writes, and without explicit breakpoints only the system prompt was
reused: every Jarvis call re-wrote the whole conversation (26 Sep 2026: 96% of
the day's spend was cache writes). A direct OpenRouter test showed 99.7–99.8%
prefix reuse with the markers, including on tools and tool results. The patch
adds `openai/gpt-6*` on OpenRouter routes to that detection and fails the build
if the upstream snippet changes.

**Removal condition:** upstream detects cache-control markers for GPT-6 on
OpenRouter (or OpenRouter reuses the conversation prefix without markers).
