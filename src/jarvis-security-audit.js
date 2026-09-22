import fs from "node:fs";
import path from "node:path";

function pickFinding(f) {
  if (!f || typeof f !== "object") return null;
  const out = {};
  for (const key of ["checkId", "severity", "title", "message", "remediation", "fix"]) {
    const value = f[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function extractJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

export async function runJarvisSecurityAuditV1({
  workspaceDir,
  runCmd,
  clawArgs,
  openclawNode,
}) {
  if (process.env.JARVIS_SECURITY_AUDIT_V1?.trim() !== "1") {
    return { ran: false, reason: "disabled" };
  }

  const dir = path.join(workspaceDir, "diagnostics");
  const resultPath = path.join(dir, "security-audit-v1.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const startedAt = new Date().toISOString();
  const r = await runCmd(
    openclawNode,
    clawArgs(["security", "audit", "--deep", "--json"]),
    { timeoutMs: 120_000 },
  );

  const parsed = extractJson(r.output);
  const sourceFindings =
    (Array.isArray(parsed?.findings) && parsed.findings) ||
    (Array.isArray(parsed?.report?.findings) && parsed.report.findings) ||
    [];
  const findings = sourceFindings.map(pickFinding).filter(Boolean);
  const summary = parsed?.summary ?? parsed?.report?.summary ?? null;

  const result = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: r.code,
    parsed: Boolean(parsed),
    summary,
    findings,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(resultPath, 0o600); } catch {}

  console.log("[security-audit-v1] completed " + JSON.stringify(result));
  return { ran: true, resultPath, exitCode: r.code, parsed: Boolean(parsed) };
}
