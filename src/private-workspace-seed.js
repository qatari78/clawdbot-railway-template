import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

function applyJarvisOrchestrationPolicyV1(workspaceDir) {
  if (process.env.JARVIS_ORCHESTRATION_POLICY_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }

  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(stateDir, "openclaw.json");
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  const backupDir = path.join(
    workspaceDir,
    "memory",
    ".seed-backups",
    "2026-09-21-orchestration-v1",
  );

  if (!fs.existsSync(configPath) || !fs.existsSync(agentsPath)) {
    console.warn("[orchestration-v1] config or AGENTS.md missing; skipping");
    return { applied: false, reason: "missing-files" };
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const backupOnce = (src, name) => {
    const dst = path.join(backupDir, name);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  };
  backupOnce(configPath, "openclaw.json.pre-v1");
  backupOnce(agentsPath, "AGENTS.md.pre-v1");

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.subagents ??= {};
  cfg.agents.defaults.subagents.delegationMode = "suggest";
  cfg.agents.defaults.subagents.maxSpawnDepth = 1;

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    verified.agents?.defaults?.subagents?.delegationMode !== "suggest" ||
    verified.agents?.defaults?.subagents?.maxSpawnDepth !== 1
  ) {
    throw new Error("orchestration config verification failed");
  }

  const marker = "## Jarvis Orchestration Policy v1";
  const policy = `
## Jarvis Orchestration Policy v1

- Jarvis/Sol performs work directly by default.
- Tools are not agents. Filesystem, API, browser/search, database, scripts, backup, validation, diff/checksum, configuration, and administrative work should use tools directly.
- Task difficulty alone never authorizes spawning.
- Deterministic, administrative, filesystem, configuration, deployment, backup, migration, and validation work uses zero subagents by default.
- Spawn only when another independent intelligence materially improves parallelism, specialist quality, independent critique, context isolation, or an explicit Forum/Counsel workflow.
- Use the minimum number of workers needed.
- Ordinary workers return to Jarvis and must not recursively spawn children.
- Forum and Counsel are governed separately and are not automatically invoked.
- Preserve primary Jarvis intelligence; cost savings should come from avoiding duplicate inference, not silently downgrading Sol.
`.trim();

  let agents = fs.readFileSync(agentsPath, "utf8");
  const existingCount = (agents.match(/## Jarvis Orchestration Policy v1/g) || []).length;
  if (existingCount === 0) {
    agents = agents.trimEnd() + "\n\n" + policy + "\n";
    fs.writeFileSync(agentsPath, agents, { encoding: "utf8", mode: 0o600 });
  } else if (existingCount > 1) {
    throw new Error("duplicate orchestration policy markers found");
  }

  const finalAgents = fs.readFileSync(agentsPath, "utf8");
  if ((finalAgents.match(/## Jarvis Orchestration Policy v1/g) || []).length !== 1) {
    throw new Error("orchestration policy verification failed");
  }

  console.log("[orchestration-v1] policy applied and verified");
  return { applied: true, backupDir };
}

export function applyPrivateWorkspaceSeed(workspaceDir) {
  try {
    applyJarvisOrchestrationPolicyV1(workspaceDir);
  } catch (err) {
    console.warn(`[orchestration-v1] failed: ${String(err)}`);
  }

  const raw = (process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_GZIP_B64 || process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_JSON)?.trim();
  if (!raw) return { applied: false, reason: "no-seed" };

  let spec;
  try {
    const bytes = Buffer.from(raw, "base64");
    const decoded = process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_GZIP_B64
      ? zlib.gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8");
    spec = JSON.parse(decoded);
  } catch (err) {
    console.warn("[workspace-seed] invalid seed payload");
    return { applied: false, reason: "invalid-seed" };
  }

  const root = path.resolve(workspaceDir);
  const backupDir = path.join(root, "memory", ".seed-backups", String(spec.id || "private-seed"));

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  for (const item of Array.isArray(spec.files) ? spec.files : []) {
    const rel = String(item.path || "");
    const dst = path.resolve(root, rel);
    if (!rel || !(dst === root || dst.startsWith(root + path.sep))) continue;

    const body = String(item.content || "").trimEnd() + "\n";
    const mode = item.mode === "append" ? "append" : "create";

    fs.mkdirSync(path.dirname(dst), { recursive: true });

    if (fs.existsSync(dst)) {
      const old = fs.readFileSync(dst, "utf8");

      if (item.marker && old.includes(String(item.marker))) {
        console.log("[workspace-seed] already present " + rel);
        continue;
      }

      if (mode === "create") {
        console.log("[workspace-seed] preserved existing " + rel);
        continue;
      }

      const safe = rel.replaceAll("/", "__");
      const backup = path.join(backupDir, safe + ".preseed");
      if (!fs.existsSync(backup)) fs.copyFileSync(dst, backup);

      fs.writeFileSync(dst, old.trimEnd() + "\n\n" + body, { encoding: "utf8", mode: 0o600 });
      console.log("[workspace-seed] appended " + rel);
    } else {
      fs.writeFileSync(dst, body, { encoding: "utf8", mode: 0o600 });
      console.log("[workspace-seed] created " + rel);
    }

    try { fs.chmodSync(dst, 0o600); } catch {}
  }

  return { applied: true };
}
