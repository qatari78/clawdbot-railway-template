import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runResearchBrief } from "../src/jarvis-research-runner.js";

// R12, end to end with a mocked OpenRouter: failures after paid research no longer discard it.

async function withMockedResearch({ scout = "ok", support = "ok" }, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-r12-"));
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, {
    JARVIS_RESEARCH_ROOT: path.join(tmp, "research"),
    OPENCLAW_STATE_DIR: path.join(tmp, "state"),
    OPENCLAW_CONFIG_PATH: path.join(tmp, "state", "openclaw.json"),
    OPENROUTER_API_KEY: "test-key",
    JARVIS_RESEARCH_VERIFIER_MODEL: "openrouter/test/verifier",
    JARVIS_RESEARCH_SCOUT_MODEL: "openrouter/test/scout",
  });
  const calls = { verifier: 0, scout: 0, support: 0 };
  const packetFor = (briefId, researcher) => ({
    schema: "jarvis-research-packet-v1.1", brief_id: briefId, researcher, memo: "m",
    claims: [{ statement: "The document exists.", claim_topic: "doc exists", polarity: "supports", basis: "direct", materiality: "high", status: "verified", evidence: [{ source_ref: "S1", type: "text", locator: "p1", paraphrase: "exists" }] }],
    sources: [{ source_id: "S1", url: "https://example.com/doc", title: "Doc" }], open_questions: [],
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (body, status = 200, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
    if (u === "https://openrouter.ai/api/v1/key") return ok({ data: {} });
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(init.body);
      const system = String(body.messages?.[0]?.content || "");
      if (system.includes("evidence-entailment checker")) {
        calls.support += 1;
        if (support === "empty") return ok({ model: "test/support", choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { cost: 0.004 } });
        return ok({ model: "test/support", choices: [{ message: { content: JSON.stringify({ results: [] }) } }], usage: { cost: 0.004 } });
      }
      const briefId = JSON.parse(String(body.messages[1].content).split("NEUTRAL BRIEF\n")[1].split("\n\n")[0]).brief_id;
      const researcher = system.includes("Jarvis Verifier") ? "verifier" : "scout";
      calls[researcher] += 1;
      if (researcher === "scout" && scout === "empty") return ok({ model: "test/scout", choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { cost: 0.01 } });
      return ok({ model: `test/${researcher}`, provider: "T", choices: [{ message: { content: `JARVIS_PACKET_START\n${JSON.stringify(packetFor(briefId, researcher))}\nJARVIS_PACKET_END` }, finish_reason: "stop" }], usage: { cost: researcher === "verifier" ? 0.2 : 0.02, server_tool_use_details: { web_search_requests: 2 } } });
    }
    return ok("<html><body>The document exists. p1</body></html>", 200, "text/html");
  };
  try {
    return await fn({ calls, tmp });
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("dual run: one researcher fails twice → one retry, partial dossier from the other", async () => {
  await withMockedResearch({ scout: "empty" }, async ({ calls, tmp }) => {
    const { summary, dossier } = await runResearchBrief({ brief: { question: "q?" }, level: "dual" });
    assert.equal(calls.verifier, 1);
    assert.equal(calls.scout, 2); // first attempt + one retry
    assert.equal(summary.pass, false);
    assert.equal(summary.partial, true);
    assert.ok(dossier && summary.dossier, "the Verifier's evidence became a dossier");
    assert.equal(summary.failures.length, 1);
    assert.match(summary.failures[0], /scout: the model returned an empty answer \(finish_reason length\) — on the retry, too/);
    assert.equal(summary.telemetry[0].attempts, 1);
    assert.equal(Math.round(summary.failed_attempt_cost_usd * 100) / 100, 0.02);
    const events = fs.readFileSync(path.join(tmp, "research", "ledger", "events.jsonl"), "utf8");
    assert.equal(events.split("\n").filter((l) => l.includes('"research-call-retry"')).length, 1);
  });
});

test("support model answers empty twice → the run still passes with its dossier; the check error is reported", async () => {
  await withMockedResearch({ support: "empty" }, async ({ calls }) => {
    const { summary, dossier } = await runResearchBrief({ brief: { question: "q?" }, level: "dual" });
    assert.equal(calls.verifier, 1);
    assert.equal(calls.scout, 1);
    assert.equal(calls.support, 2); // one retry
    assert.equal(summary.pass, true);
    assert.ok(dossier, "dossier built without the support check");
    assert.equal(summary.semantic_support, null);
    assert.equal(summary.check_errors.length, 1);
    assert.match(summary.check_errors[0], /support check failed twice: the support model returned an empty answer/);
    assert.equal(Math.round(summary.total_cost_usd * 1000) / 1000, 0.228); // 0.2 + 0.02 + 2 × 0.004
  });
});

test("healthy run: no retries, no check errors", async () => {
  await withMockedResearch({}, async ({ calls }) => {
    const { summary } = await runResearchBrief({ brief: { question: "q?" }, level: "dual" });
    assert.deepEqual(calls, { verifier: 1, scout: 1, support: 1 });
    assert.equal(summary.pass, true);
    assert.equal(summary.partial, false);
    assert.deepEqual(summary.check_errors, []);
    assert.deepEqual(summary.failures, []);
  });
});
