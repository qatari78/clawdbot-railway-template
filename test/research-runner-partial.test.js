import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runResearchBrief } from "../src/jarvis-research-runner.js";

// R12: a dual run where the Scout keeps returning an empty answer: the Scout is retried once, the
// Verifier is called once, and the Verifier's evidence still becomes a dossier marked partial.

test("dual run: one researcher fails twice → one retry, partial dossier from the other", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-partial-"));
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
  const calls = { verifier: 0, scout: 0, other: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (body, status = 200, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
    if (u === "https://openrouter.ai/api/v1/key") return ok({ data: {} });
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(init.body);
      const system = String(body.messages?.[0]?.content || "");
      const briefId = JSON.parse(String(body.messages[1].content).split("NEUTRAL BRIEF\n")[1].split("\n\n")[0]).brief_id;
      if (system.includes("Jarvis Verifier")) {
        calls.verifier += 1;
        const packet = { schema: "jarvis-research-packet-v1.1", brief_id: briefId, researcher: "verifier", memo: "m", claims: [], sources: [{ source_id: "S1", url: "https://example.com/doc", title: "Doc" }], open_questions: [] };
        return ok({ model: "test/verifier", provider: "T", choices: [{ message: { content: `JARVIS_PACKET_START\n${JSON.stringify(packet)}\nJARVIS_PACKET_END` }, finish_reason: "stop" }], usage: { cost: 0.2, server_tool_use_details: { web_search_requests: 2 } } });
      }
      if (system.includes("Jarvis Scout")) {
        calls.scout += 1;
        return ok({ model: "test/scout", choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { cost: 0.01 } });
      }
      calls.other.push("chat");
      return ok({ error: { message: "unexpected call" } }, 400);
    }
    calls.other.push(u);
    return ok("<html><body>Doc</body></html>", 200, "text/html");
  };
  try {
    const { summary, dossier } = await runResearchBrief({ brief: { question: "q?" }, level: "dual" });
    assert.equal(calls.verifier, 1);
    assert.equal(calls.scout, 2); // first attempt + one retry
    assert.equal(summary.pass, false);
    assert.equal(summary.partial, true);
    assert.ok(dossier && summary.dossier, "the Verifier's evidence became a dossier");
    assert.equal(summary.failures.length, 1);
    assert.match(summary.failures[0], /scout: the model returned an empty answer \(finish_reason length\) — on the retry, too/);
    assert.equal(Math.round(summary.total_cost_usd * 100) / 100, 0.22); // 0.20 verifier + 2 × 0.01 failed scout attempts
    assert.equal(summary.telemetry[0].attempts, 1);
    const events = fs.readFileSync(path.join(tmp, "research", "ledger", "events.jsonl"), "utf8");
    assert.equal(events.split("\n").filter((l) => l.includes('"research-call-retry"')).length, 1);
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
