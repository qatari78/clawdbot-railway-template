import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwnerApprovals, isLoopbackRequest } from "../src/salem-approvals.js";

test("owner code: sent to the owner, single use, 3 tries, expiry", async () => {
  let t = 1_000_000;
  const sent = [];
  const a = createOwnerApprovals({ send: async (text) => { sent.push(text); return { ok: true }; }, now: () => t, randomCode: () => "482913" });
  assert.equal((await a.request("agent-factory", "abc123def456", "create agent x")).ok, true);
  assert.match(sent[0], /482 913/);
  assert.equal(a.verify("agent-factory", "abc123def456", "000000").ok, false);
  assert.equal(a.verify("agent-factory", "abc123def456", "482 913").ok, true);
  assert.equal(a.verify("agent-factory", "abc123def456", "482913").ok, false, "single use");

  await a.request("agent-factory", "plan2plan2", "x");
  a.verify("agent-factory", "plan2plan2", "1"); a.verify("agent-factory", "plan2plan2", "2");
  assert.match(a.verify("agent-factory", "plan2plan2", "3").error, /cancelled/);
  assert.equal(a.verify("agent-factory", "plan2plan2", "482913").ok, false, "cancelled after 3 tries");

  await a.request("agent-factory", "plan3plan3", "x");
  t += 31 * 60 * 1000;
  assert.match(a.verify("agent-factory", "plan3plan3", "482913").error, /expired/);
});

test("no code is kept when the owner cannot be reached", async () => {
  const a = createOwnerApprovals({ send: async () => ({ ok: false }), randomCode: () => "111111" });
  assert.equal((await a.request("agent-factory", "abcdabcd", "x")).status, 502);
  assert.equal(a.pendingCount(), 0);
  assert.equal((await a.request("BAD KIND", "abcdabcd", "x")).status, 400);
});

test("only loopback requests without proxy headers are local", () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: {} }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "1.2.3.4" } }), false);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" }, headers: {} }), false);
});
