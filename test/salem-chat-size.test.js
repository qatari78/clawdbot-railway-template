import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOwnerChatKey, ownerChatRows, chatsToCompact, chatSizeLine, createChatSizeKeeper, CHAT_CAP_TOKENS,
  modelDrift, chatsToRelease, chatReportLines,
} from "../src/salem-chat-size.js";

const NOW = Date.parse("2026-09-26T16:00:00Z");
const MIN = 60_000;

// Shape of an OpenClaw v2026.9.6 sessions.list result (fields trimmed), as read live on 26 Sep.
const listResult = {
  ts: NOW, count: 5,
  sessions: [
    { key: "agent:main:whatsapp:direct:+97466586586", sessionId: "wa-1", totalTokens: 282246, totalTokensFresh: true, updatedAt: NOW - 40 * MIN, lastInteractionAt: NOW - 40 * MIN, endedAt: NOW - 39 * MIN, hasActiveRun: false, status: "done" },
    { key: "agent:main:telegram:direct:8992093410", sessionId: "tg-1", totalTokens: 30513, updatedAt: NOW - 3 * 24 * 60 * MIN, hasActiveRun: false },
    { key: "agent:main:main", sessionId: "main-1", totalTokens: 16839, updatedAt: NOW - 10 * 60 * MIN },
    { key: "agent:main:whatsapp:group:1203@g.us", sessionId: "g-1", totalTokens: 74825, updatedAt: NOW - 5 * 24 * 60 * MIN },
    { key: "agent:main:explicit:claude-test-x", sessionId: "t-1", totalTokens: 99000, updatedAt: NOW - 60 * MIN },
    { key: "agent:forum-01:main", sessionId: "f-1", totalTokens: 120000, updatedAt: NOW - 60 * MIN },
  ],
};

test("owner chat keys: Jarvis's DMs and main session only", () => {
  assert.ok(isOwnerChatKey("agent:main:whatsapp:direct:+97466586586"));
  assert.ok(isOwnerChatKey("agent:main:telegram:direct:8992093410"));
  assert.ok(isOwnerChatKey("agent:main:main"));
  assert.ok(!isOwnerChatKey("agent:main:whatsapp:group:1203@g.us"));
  assert.ok(!isOwnerChatKey("agent:main:explicit:claude-test-x"));
  assert.ok(!isOwnerChatKey("agent:forum-01:main"));
  assert.ok(!isOwnerChatKey("agent:main:whatsapp:direct:+974 6658"));
  assert.ok(!isOwnerChatKey(undefined));
});

test("rows from a sessions.list result", () => {
  const rows = ownerChatRows(listResult);
  assert.deepEqual(rows.map((r) => r.key).sort(), ["agent:main:main", "agent:main:telegram:direct:8992093410", "agent:main:whatsapp:direct:+97466586586"]);
  const wa = rows.find((r) => r.key.includes("whatsapp"));
  assert.equal(wa.totalTokens, 282246);
  assert.equal(wa.lastActivityAt, NOW - 39 * MIN); // latest of updatedAt / lastInteractionAt / endedAt
  assert.equal(wa.active, false);
  assert.deepEqual(ownerChatRows(null), []);
  assert.deepEqual(ownerChatRows({ sessions: [{ key: "agent:main:main", archived: true, totalTokens: 90000 }] }), []);
});

test("which chats get summarised", () => {
  const rows = ownerChatRows(listResult);
  assert.deepEqual(chatsToCompact(rows, { now: NOW }).map((r) => r.key), ["agent:main:whatsapp:direct:+97466586586"]);
  // still in use (quiet for less than 10 minutes) → wait
  assert.deepEqual(chatsToCompact(rows, { now: NOW - 35 * MIN }), []);
  // a run in progress → wait
  assert.deepEqual(chatsToCompact(rows.map((r) => ({ ...r, active: true })), { now: NOW }), []);
  // tried 10 minutes ago → wait for the retry window
  assert.deepEqual(chatsToCompact(rows, { now: NOW, lastAttempt: { "agent:main:whatsapp:direct:+97466586586": NOW - 10 * MIN } }), []);
  assert.equal(chatsToCompact(rows, { now: NOW, lastAttempt: { "agent:main:whatsapp:direct:+97466586586": NOW - 31 * MIN } }).length, 1);
  // under the cap or unknown size → nothing
  assert.deepEqual(chatsToCompact([{ key: "agent:main:main", totalTokens: CHAT_CAP_TOKENS, lastActivityAt: NOW - 60 * MIN, active: false }], { now: NOW }), []);
  assert.deepEqual(chatsToCompact([{ key: "agent:main:main", totalTokens: NaN, lastActivityAt: NOW - 60 * MIN, active: false }], { now: NOW }), []);
});

test("chat size line for the daily report", () => {
  const line = chatSizeLine(ownerChatRows(listResult));
  assert.equal(line, "Jarvis chat size now: WhatsApp 282k tokens (over the cap — summarising when quiet) · Telegram 31k tokens (summarised automatically above 60k)");
  assert.equal(chatSizeLine([{ key: "agent:main:whatsapp:direct:+1", totalTokens: 9400 }]), "Jarvis chat size now: WhatsApp 9.4k tokens (summarised automatically above 60k)");
  assert.equal(chatSizeLine([]), "");
});

test("keeper: summarises a quiet oversized chat once, retries later, never while stopped", async () => {
  const calls = [];
  let running = true;
  const keeper = createChatSizeKeeper({
    gatewayCall: async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.list") return listResult;
      if (method === "sessions.compact") return { ok: true, key: params.key, compacted: true };
      throw new Error("unexpected " + method);
    },
    canQuery: () => running,
    log: { log() {}, warn() {} },
  });
  const r1 = await keeper.tick(NOW);
  assert.equal(r1.compacted.length, 1);
  assert.deepEqual(calls.filter(([m]) => m === "sessions.compact").map(([, p]) => p.key), ["agent:main:whatsapp:direct:+97466586586"]);
  const r2 = await keeper.tick(NOW + 5 * MIN); // within the retry window: no second summary
  assert.equal(r2.compacted.length, 0);
  running = false;
  assert.equal(await keeper.tick(NOW + 60 * MIN), null);
  assert.equal(keeper.status().lastResult.compacted, true);
});

test("keeper: a refused summary (chat busy) is logged and retried later", async () => {
  const keeper = createChatSizeKeeper({
    gatewayCall: async (method) => {
      if (method === "sessions.list") return listResult;
      throw new Error("sessions.compact failed (exit 1): Session has an active run; retry after it finishes.");
    },
    log: { log() {}, warn() {} },
  });
  const r = await keeper.tick(NOW);
  assert.equal(r.compacted[0].ok, false);
  assert.match(r.compacted[0].error, /active run/);
  assert.equal((await keeper.tick(NOW + 31 * MIN)).compacted.length, 1);
});

// R17b: model drift. Rows as sessions.list reported them on 26 Sep 16:11Z (before the Telegram fix).
const JARVIS = { defaultModel: "openrouter/openai/gpt-6-sol", defaultThinking: "high" };
const modelRows = ownerChatRows({ sessions: [
  { key: "agent:main:whatsapp:direct:+97466586586", totalTokens: 14000, updatedAt: NOW, modelProvider: "openrouter", model: "openai/gpt-6-sol", modelOverrideSource: null, thinkingDefault: "high" },
  { key: "agent:main:telegram:direct:8992093410", totalTokens: 30513, updatedAt: NOW - 3 * 24 * 60 * MIN, modelProvider: "openrouter", model: "openai/gpt-5.6-sol", modelOverrideSource: "user", thinkingDefault: "high" },
  { key: "agent:main:main", totalTokens: 16839, updatedAt: NOW, modelProvider: "openrouter", model: "openai/gpt-6-sol", thinkingDefault: "high" },
] });

test("model drift: a chat left on another model is reported with the fix", () => {
  assert.equal(modelRows.find((r) => r.key.includes("telegram")).modelRef, "openrouter/openai/gpt-5.6-sol");
  const issues = modelDrift(modelRows, JARVIS);
  assert.deepEqual(issues.map((i) => [i.label, i.kind]), [["Telegram", "set-in-chat"]]);
  const text = chatReportLines(modelRows, JARVIS);
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /^Jarvis chat size now: WhatsApp 14k tokens · Telegram 31k tokens \(summarised automatically above 60k\)\n/);
  assert.match(text, /⚠️ Model check: Telegram chat runs gpt-5\.6-sol \(chosen in that chat\) — Jarvis's default is gpt-6-sol\. To put a chat back, send \/model default -s in it, or ask Claude\.$/);
});

test("model drift: all chats on the default → one confirming line", () => {
  const fixed = modelRows.map((r) => (r.key.includes("telegram") ? { ...r, modelRef: "openrouter/openai/gpt-6-sol", overrideSource: null } : r));
  assert.deepEqual(modelDrift(fixed, JARVIS), []);
  assert.equal(chatReportLines(fixed, JARVIS), "Jarvis chat size now: WhatsApp 14k tokens · Telegram 31k tokens (summarised automatically above 60k) · all chats on gpt-6-sol");
  // backup model and a chat-level thinking change are reported too
  const odd = fixed.map((r) => (r.key.includes("whatsapp") ? { ...r, modelRef: "openrouter/x-ai/grok-4.7", overrideSource: "auto" } : r.key.includes("telegram") ? { ...r, thinkingLevel: "low" } : r));
  const t = chatReportLines(odd, JARVIS);
  assert.match(t, /WhatsApp chat is on the backup model grok-4\.7 \(the main model failed there\); Telegram chat thinking is low \(Jarvis: high\)/);
  assert.match(t, /send \/model default -s and \/think default in it/);
  // no known default → no model claims at all
  assert.equal(chatReportLines(modelRows, {}), "Jarvis chat size now: WhatsApp 14k tokens · Telegram 31k tokens (summarised automatically above 60k)");
});

test("release: a chat's own choice that equals Jarvis's default is released, others are not", () => {
  const rows = [
    { key: "agent:main:whatsapp:direct:+1", modelRef: "openrouter/openai/gpt-6-sol", overrideSource: "user", thinkingLevel: null, thinkingDefault: "high", active: false },
    { key: "agent:main:telegram:direct:2", modelRef: "openrouter/openai/gpt-5.6-sol", overrideSource: "user", thinkingLevel: null, thinkingDefault: "high", active: false },
    { key: "agent:main:main", modelRef: "openrouter/openai/gpt-6-sol", overrideSource: "user", thinkingLevel: "low", thinkingDefault: "high", active: false },
    { key: "agent:main:telegram:direct:3", modelRef: "openrouter/openai/gpt-6-sol", overrideSource: "user", thinkingLevel: null, thinkingDefault: "high", active: true },
    { key: "agent:main:telegram:direct:4", modelRef: "openrouter/openai/gpt-6-sol", overrideSource: "auto", thinkingLevel: null, thinkingDefault: "high", active: false },
  ];
  assert.deepEqual(chatsToRelease(rows, { ...JARVIS, now: NOW }).map((r) => r.key), ["agent:main:whatsapp:direct:+1"]);
  assert.deepEqual(chatsToRelease(rows, { ...JARVIS, now: NOW, lastRelease: { "agent:main:whatsapp:direct:+1": NOW - 5 * MIN } }), []);
  assert.deepEqual(chatsToRelease(rows, { now: NOW }), []);
});

test("keeper: releases a same-as-default choice once and reports drift in the report line", async () => {
  const calls = [];
  const keeper = createChatSizeKeeper({
    gatewayCall: async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.list") return { sessions: [
        { key: "agent:main:whatsapp:direct:+97466586586", totalTokens: 9000, updatedAt: NOW, modelProvider: "openrouter", model: "openai/gpt-6-sol", modelOverrideSource: "user", thinkingDefault: "high" },
        { key: "agent:main:telegram:direct:8992093410", totalTokens: 30513, updatedAt: NOW, modelProvider: "openrouter", model: "openai/gpt-5.6-sol", modelOverrideSource: "user", thinkingDefault: "high" },
      ] };
      if (method === "sessions.patch") return { ok: true };
      throw new Error("unexpected " + method);
    },
    jarvisDefault: () => ({ model: "openrouter/openai/gpt-6-sol", thinking: "high" }),
    log: { log() {}, warn() {} },
  });
  const r = await keeper.tick(NOW);
  assert.deepEqual(calls.filter(([m]) => m === "sessions.patch").map(([, p]) => p), [{ key: "agent:main:whatsapp:direct:+97466586586", model: null }]);
  assert.equal(r.released.length, 1);
  assert.equal((await keeper.tick(NOW + MIN)).released.length, 0); // not again inside the retry window
  assert.match(await keeper.line(), /⚠️ Model check: Telegram chat runs gpt-5\.6-sol/);
  // a broken config read never breaks the keeper
  const k2 = createChatSizeKeeper({ gatewayCall: async () => ({ sessions: [] }), jarvisDefault: () => { throw new Error("no config"); }, log: { log() {}, warn() {} } });
  assert.equal(await k2.line(), "");
  assert.deepEqual((await k2.tick(NOW)).released, []);
});
