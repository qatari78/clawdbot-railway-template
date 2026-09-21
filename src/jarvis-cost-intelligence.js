import fs from "node:fs";
import path from "node:path";

const MARKER = "<!-- managed-by: jarvis-cost-intelligence-v1 -->";

function backupOnce(src, backupDir, name) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dst = path.join(backupDir, name);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}

function writeManagedFile(filePath, body, backupDir, backupName) {
  const normalized = body.trimEnd() + "\n";
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === normalized) return false;
    backupOnce(filePath, backupDir, backupName);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, normalized, { encoding: "utf8", mode: 0o600 });
  return true;
}

export function installJarvisCostIntelligenceV1(workspaceDir) {
  if (process.env.JARVIS_COST_INTELLIGENCE_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }

  const backupDir = path.join(workspaceDir, "memory", ".seed-backups", "2026-09-22-cost-intelligence-v1");
  const skillPath = path.join(workspaceDir, "skills", "jarvis-cost-intelligence", "SKILL.md");
  const telemetryReadmePath = path.join(workspaceDir, "telemetry", "README.md");
  const skill = "---\nname: jarvis-cost-intelligence\ndescription: Use OpenClaw native usage telemetry to report spend, forecast burn, attribute usage, and propose model-routing improvements without silently reducing quality.\nuser-invocable: false\n---\n\n# Jarvis Cost + Model Intelligence v1\n\n<!-- managed-by: jarvis-cost-intelligence-v1 -->\n\n## Principle\n\nUse OpenClaw's native usage/session accounting as the source of truth for local telemetry. Do not build a second token ledger when the runtime already records usage.\n\nPrimary commands/surfaces:\n- `openclaw gateway usage-cost --all-agents --json` for aggregate multi-agent usage/cost.\n- `openclaw gateway usage-cost --agent <id> --json` for one agent.\n- `openclaw gateway usage-cost --days <n> --json` for bounded windows.\n- `openclaw sessions --all-agents --json` for session/model/token metadata and attribution support.\n- `openclaw status --usage` for provider quota windows.\n- Per-session `session_status`, `/status`, and `/usage cost` when conversational context is the right scope.\n\nWhen invoking CLI commands from Jarvis, use the normal supported execution tool. Never print provider keys, auth profiles, gateway tokens, or environment-variable values.\n\n## Cost reporting\n\nWhen asked for spend, provide:\n1. today / requested window;\n2. month-to-date when available;\n3. current daily run rate;\n4. projected month-end cost using a clearly stated simple projection;\n5. cost by agent and model when the telemetry supports it;\n6. uncertainty when pricing metadata or cache state is incomplete.\n\nDo not present OpenClaw local estimates as a provider invoice. Preserve cache-status/incomplete warnings from the native telemetry.\n\n## Attribution\n\nPrefer stable session labels when spawning new work. Use labels that encode purpose without personal secrets, for example:\n- `jarvis:research:<project>:<run-id>:r1`\n- `jarvis:forum:<project>:<run-id>:f2`\n- `jarvis:counsel:<project>:<run-id>:c1`\n- `jarvis:operator:<project>:<run-id>:<role>`\n\nIf no project is supplied, use a neutral category such as `general`; do not guess a sensitive project name from memory.\n\n## Budget behavior\n\n- No numeric budget ceiling exists until the owner sets one.\n- Once limits are set, issue soft warnings before projected overrun.\n- Do not interrupt low-cost normal work merely because a budget exists.\n- Material spend-limit increases require owner approval.\n- If a cost-saving change materially reduces quality, require owner approval before applying it.\n- Optimize duplicate research, redundant adviser passes, cache reuse, and model routing before lowering the primary intelligence level.\n\n## Model intelligence\n\nSeparate seat identity from model occupancy. Forum/Counsel/research seat IDs stay stable while model assignments may change.\n\nWhen evaluating a routing change, compare:\n- task quality/capability fit;\n- latency;\n- input/output/cache pricing;\n- context-window/tool support;\n- observed failure/retry rate;\n- provider availability and rate limits;\n- whether the change affects only a worker seat or the primary Jarvis brain.\n\nModel changes are recommendations first. Do not automatically replace the primary Jarvis model or materially downgrade a room seat.\n\nWhen a materially better or cheaper model appears, produce a short migration proposal with current route, candidate route, expected benefit, risk, and rollback. Apply only after owner approval if the change is material.\n\n## Storage\n\nIf saving telemetry snapshots, use `/data/workspace/telemetry/usage/` and keep them aggregate. Do not store prompts, secrets, passwords, API keys, or personal-memory copies in telemetry.\n";
  const readme = "# Jarvis telemetry workspace\n\n<!-- managed-by: jarvis-cost-intelligence-v1 -->\n\nPurpose: aggregate cost, token, model, session-attribution, and benchmark artifacts used by Jarvis Cost + Model Intelligence.\n\nRecommended layout:\n- `telemetry/usage/` — aggregate usage-cost snapshots.\n- `telemetry/benchmarks/` — model benchmark summaries and dated comparisons.\n- `telemetry/routing/` — proposed routing changes and rollback notes.\n\nRules:\n- No API keys, tokens, passwords, provider credentials, or raw secret-bearing config.\n- No duplicate personal-memory profile.\n- Prefer OpenClaw native usage records over a parallel hand-built accounting ledger.\n- Keep model recommendations dated because prices and capabilities change.\n";

  const changedSkill = writeManagedFile(skillPath, skill, backupDir, "SKILL.md.pre-v1");
  const changedReadme = writeManagedFile(telemetryReadmePath, readme, backupDir, "telemetry-README.md.pre-v1");

  const verifySkill = fs.readFileSync(skillPath, "utf8");
  const verifyReadme = fs.readFileSync(telemetryReadmePath, "utf8");
  if (!verifySkill.includes(MARKER) || !verifySkill.includes("# Jarvis Cost + Model Intelligence v1")) {
    throw new Error("cost intelligence skill verification failed");
  }
  if (!verifyReadme.includes(MARKER)) throw new Error("telemetry README verification failed");

  try { fs.chmodSync(skillPath, 0o600); } catch {}
  try { fs.chmodSync(telemetryReadmePath, 0o600); } catch {}

  console.log("[cost-intelligence-v1] installed and verified");
  return { applied: true, changed: changedSkill || changedReadme, skillPath, telemetryReadmePath, backupDir };
}
