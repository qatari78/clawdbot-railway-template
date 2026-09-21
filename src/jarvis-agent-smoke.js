import fs from "node:fs";
import path from "node:path";

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(raw.slice(first, last + 1)); } catch { return null; }
}

function sessionKeys(output) {
  const parsed = extractJsonObject(output);
  const rows = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return new Set(rows.map((row) => String(row?.key || "")).filter(Boolean));
}

export async function runJarvisAgentSmokeV1({
  workspaceDir,
  runCmd,
  clawArgs,
  openclawNode,
}) {
  if (process.env.JARVIS_AGENT_SMOKE_V1?.trim() !== "1") {
    return { ran: false, reason: "disabled" };
  }

  const dir = path.join(workspaceDir, "diagnostics");
  const resultPath = path.join(dir, "research-routing-smoke-v1.json");
  if (fs.existsSync(resultPath)) {
    console.log("[agent-smoke-v1] prior result exists; skipping");
    return { ran: false, reason: "already-ran", resultPath };
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();

  const runAgent = async (agentId, message, expected, timeoutMs = 120_000) => {
    const start = Date.now();
    const r = await runCmd(
      openclawNode,
      clawArgs(["agent", "--agent", agentId, "--message", message, "--json"]),
      { timeoutMs },
    );
    return {
      ok: r.code === 0 && String(r.output || "").includes(expected),
      exitCode: r.code,
      expectedMarkerSeen: String(r.output || "").includes(expected),
      elapsedMs: Date.now() - start,
    };
  };

  const direct01 = await runAgent(
    "research-01",
    "Smoke test only. Do not browse. Reply exactly: RESEARCH_01_OK",
    "RESEARCH_01_OK",
  );

  const direct02 = await runAgent(
    "research-02",
    "Smoke test only. Do not browse. Reply exactly: RESEARCH_02_OK",
    "RESEARCH_02_OK",
  );

  const beforeSessions = await runCmd(
    openclawNode,
    clawArgs(["sessions", "--agent", "research-01", "--active", "10", "--limit", "100", "--json"]),
    { timeoutMs: 30_000 },
  );
  const beforeKeys = sessionKeys(beforeSessions.output);

  const routed = await runAgent(
    "main",
    [
      "Internal orchestration smoke test.",
      "You MUST use sessions_spawn to delegate one isolated child task to agentId research-01.",
      "Give the child this exact task: Smoke test only. Do not browse. Reply exactly ROUTED_CHILD_OK.",
      "Use a label containing smoke-research-route-v1 if the tool supports labels.",
      "Wait for the child result using the supported session/subagent completion mechanism.",
      "Reply exactly ROUTER_OK only if the delegated child returned ROUTED_CHILD_OK.",
      "Do not browse, change configuration, restart services, or perform any other work.",
    ].join(" "),
    "ROUTER_OK",
    180_000,
  );

  const afterSessions = await runCmd(
    openclawNode,
    clawArgs(["sessions", "--agent", "research-01", "--active", "10", "--limit", "100", "--json"]),
    { timeoutMs: 30_000 },
  );
  const afterKeys = sessionKeys(afterSessions.output);
  const newSubagentKeys = [...afterKeys].filter(
    (key) => key.includes(":subagent:") && !beforeKeys.has(key),
  );

  const result = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    directResearch01: direct01,
    directResearch02: direct02,
    jarvisDelegation: {
      ...routed,
      newResearchSubagentSessionObserved: newSubagentKeys.length > 0,
      newResearchSubagentSessionCount: newSubagentKeys.length,
    },
    pass:
      direct01.ok &&
      direct02.ok &&
      routed.ok &&
      newSubagentKeys.length > 0,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(resultPath, 0o600); } catch {}

  console.log(
    "[agent-smoke-v1] completed " +
      JSON.stringify({
        pass: result.pass,
        research01: direct01.ok,
        research02: direct02.ok,
        jarvisDelegation: routed.ok,
        delegatedSessionObserved: newSubagentKeys.length > 0,
      }),
  );

  return { ran: true, resultPath, pass: result.pass };
}
