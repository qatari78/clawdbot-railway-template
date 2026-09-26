import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOwnerChatKey, ownerChatRows, chatsToCompact, chatSizeLine, createChatSizeKeeper, CHAT_CAP_TOKENS,
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
