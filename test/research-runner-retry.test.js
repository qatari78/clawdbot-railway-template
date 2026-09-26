import { test } from "node:test";
import assert from "node:assert/strict";
import { callResearch, researchWithRetry, ResearchCallError } from "../src/jarvis-research-runner.js";

// R12: a researcher call that fails for a transient reason is retried once, for that researcher only.

const brief = { brief_id: "b1", question: "q" };
const base = { apiKey: "k", model: "openrouter/x/y", researcher: "verifier", brief, searchEngine: "native", level: "dual" };
const packet = (over = {}) => ({ schema: "jarvis-research-packet-v1.1", brief_id: "b1", researcher: "verifier", memo: "m", claims: [], sources: [{ source_id: "S1", url: "https://example.com" }], ...over });
const reply = (content, extra = {}) => JSON.stringify({
  model: "x/y", provider: "P",
  choices: [{ message: { content }, finish_reason: extra.finish ?? "stop" }],
  usage: { cost: extra.cost ?? 0.1, server_tool_use_details: { web_search_requests: 2 } },
  ...(extra.error ? { error: extra.error } : {}),
});
const fetchReturning = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const sentinel = (obj) => `JARVIS_PACKET_START\n${JSON.stringify(obj)}\nJARVIS_PACKET_END`;

test("a good answer returns the packet and its cost", async () => {
  const r = await callResearch({ ...base, fetchImpl: fetchReturning(200, reply(sentinel(packet()))) });
  assert.equal(r.packet.brief_id, "b1");
  assert.equal(r.telemetry.usage.cost, 0.1);
});

test("an empty body (the 26 Sep 'Unexpected end of JSON input') is a clear, retryable error", async () => {
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(200, "   ") }), (e) => {
    assert.ok(e instanceof ResearchCallError);
    assert.equal(e.retryable, true);
    assert.match(e.message, /verifier: OpenRouter's reply was cut off or not JSON/);
    return true;
  });
});

test("an empty model answer is retryable and names the finish reason; its cost is kept", async () => {
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(200, reply("", { finish: "length", cost: 0.07 })) }), (e) => {
    assert.equal(e.retryable, true);
    assert.match(e.message, /empty answer \(finish_reason length\)/);
    assert.equal(e.cost, 0.07);
    return true;
  });
});

test("a cut-off packet and a provider error are retryable", async () => {
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(200, reply('JARVIS_PACKET_START {"brief_id": "b1", JARVIS_PACKET_END')) }), (e) => e.retryable === true && /not a valid research packet/.test(e.message));
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(200, reply("", { error: { message: "upstream timeout" } })) }), (e) => e.retryable === true && /provider error/.test(e.message));
});

test("HTTP 429/5xx and dropped connections are retryable; 400, time-outs and wrong packets are not", async () => {
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(503, "{}") }), (e) => e.retryable === true);
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(429, '{"error":{"message":"rate"}}') }), (e) => e.retryable === true && /rate/.test(e.message));
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(400, '{"error":{"message":"bad"}}') }), (e) => e.retryable === false);
  await assert.rejects(callResearch({ ...base, fetchImpl: async () => { throw new Error("socket hang up"); } }), (e) => e.retryable === true && /connection to OpenRouter failed/.test(e.message));
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(callResearch({ ...base, timeoutMs: 30, fetchImpl: hang }), (e) => e.retryable === false && /no complete answer within/.test(e.message));
  await assert.rejects(callResearch({ ...base, fetchImpl: fetchReturning(200, reply(sentinel(packet({ brief_id: "other" })))) }), (e) => e.retryable === false && /wrong brief_id/.test(e.message));
});

test("retry: one transient failure, then success — two attempts, the failed attempt's cost counted", async () => {
  let calls = 0; let slept = 0; const retried = [];
  const call = async () => { calls += 1; if (calls === 1) throw new ResearchCallError("verifier: the model returned an empty answer", { retryable: true, cost: 0.05 }); return { packet: packet(), telemetry: {} }; };
  const r = await researchWithRetry(base, { call, sleep: async () => { slept += 1; }, onRetry: (e) => retried.push(e.message) });
  assert.equal(calls, 2);
  assert.equal(slept, 1);
  assert.equal(r.attempts, 2);
  assert.equal(r.failedCost, 0.05);
  assert.deepEqual(retried, ["verifier: the model returned an empty answer"]);
});

test("retry: a non-transient failure is not retried", async () => {
  let calls = 0;
  const call = async () => { calls += 1; throw new ResearchCallError("verifier returned no sources", { cost: 0.2 }); };
  await assert.rejects(researchWithRetry(base, { call, sleep: async () => {} }), (e) => e.failedCost === 0.2 && /no sources/.test(e.message));
  assert.equal(calls, 1);
});

test("retry: no retry when less than 5 minutes of the call window remain", async () => {
  let t = 0; let calls = 0;
  const call = async () => { calls += 1; t += 18 * 60 * 1000; throw new ResearchCallError("verifier: connection to OpenRouter failed", { retryable: true }); };
  await assert.rejects(researchWithRetry(base, { call, now: () => t, sleep: async () => {} }));
  assert.equal(calls, 1);
});

test("retry: the retry's time limit fits the window", async () => {
  let t = 0; const limits = [];
  const call = async (a) => { limits.push(a.timeoutMs); if (limits.length === 1) { t += 9 * 60 * 1000; throw new ResearchCallError("x", { retryable: true }); } return { packet: packet(), telemetry: {} }; };
  await researchWithRetry(base, { call, now: () => t, sleep: async () => {} });
  assert.deepEqual(limits, [10 * 60 * 1000, 10 * 60 * 1000]);
  t = 0; limits.length = 0;
  await researchWithRetry({ ...base, level: "heavy" }, { call: async (a) => { limits.push(a.timeoutMs); if (limits.length === 1) { t += 10 * 60 * 1000; throw new ResearchCallError("x", { retryable: true }); } return { packet: packet(), telemetry: {} }; }, now: () => t, sleep: async () => {} });
  assert.deepEqual(limits, [20 * 60 * 1000, 12 * 60 * 1000 - 5000]);
});

test("retry: two failures name both attempts and add up their cost", async () => {
  let calls = 0;
  const call = async () => { calls += 1; throw new ResearchCallError(calls === 1 ? "verifier: empty answer" : "verifier: provider error", { retryable: true, cost: 0.03 }); };
  await assert.rejects(researchWithRetry(base, { call, sleep: async () => {} }), (e) => {
    assert.match(e.message, /verifier: provider error — on the retry, too \(first attempt: verifier: empty answer\)/);
    assert.equal(e.failedCost, 0.06);
    return true;
  });
});
