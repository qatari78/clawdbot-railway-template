import fs from "node:fs";
import path from "node:path";

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
  const resultPath = path.join(dir, "room-seat-smoke-v2.json");
  if (fs.existsSync(resultPath)) {
    console.log("[agent-smoke-v2] prior result exists; skipping");
    return { ran: false, reason: "already-ran", resultPath };
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();

  const runAgent = async (agentId, marker, timeoutMs = 120_000) => {
    const start = Date.now();
    try {
      const r = await runCmd(
        openclawNode,
        clawArgs([
          "agent",
          "--agent",
          agentId,
          "--message",
          `Smoke test only. Do not browse or use tools. Reply exactly: ${marker}`,
          "--json",
        ]),
        { timeoutMs },
      );
      const output = String(r.output || "");
      return {
        agentId,
        ok: r.code === 0 && output.includes(marker),
        exitCode: r.code,
        expectedMarkerSeen: output.includes(marker),
        elapsedMs: Date.now() - start,
        errorClass: r.code === 0 ? null :
          (/402|billing|credits|afford/i.test(output) ? "billing" :
          (/No callable tools remain|tool allowlist|no registered tools/i.test(output) ? "tools" : "other")),
      };
    } catch (err) {
      const output = String(err?.message || err || "");
      return {
        agentId,
        ok: false,
        exitCode: null,
        expectedMarkerSeen: false,
        elapsedMs: Date.now() - start,
        errorClass:
          (/402|billing|credits|afford/i.test(output) ? "billing" :
          (/No callable tools remain|tool allowlist|no registered tools/i.test(output) ? "tools" : "other")),
      };
    }
  };

  const seats = [
    ["forum-01", "FORUM_01_HI"],
    ["forum-02", "FORUM_02_HI"],
    ["forum-03", "FORUM_03_HI"],
    ["counsel-01", "COUNSEL_01_HI"],
    ["counsel-02", "COUNSEL_02_HI"],
    ["counsel-03", "COUNSEL_03_HI"],
  ];

  const results = [];
  for (const [agentId, marker] of seats) {
    const result = await runAgent(agentId, marker);
    results.push(result);
    console.log("[agent-smoke-v2] seat " + JSON.stringify(result));
  }

  const summary = {
    version: 2,
    startedAt,
    finishedAt: new Date().toISOString(),
    seats: results,
    pass: results.every((r) => r.ok),
    toolFailures: results.filter((r) => r.errorClass === "tools").map((r) => r.agentId),
    billingFailures: results.filter((r) => r.errorClass === "billing").map((r) => r.agentId),
    otherFailures: results.filter((r) => !r.ok && r.errorClass === "other").map((r) => r.agentId),
  };

  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(resultPath, 0o600); } catch {}

  console.log("[agent-smoke-v2] completed " + JSON.stringify({
    pass: summary.pass,
    toolFailures: summary.toolFailures,
    billingFailures: summary.billingFailures,
    otherFailures: summary.otherFailures,
  }));

  return { ran: true, resultPath, pass: summary.pass };
}
