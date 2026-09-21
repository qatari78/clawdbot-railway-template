import childProcess from "node:child_process";
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


function applyJarvisMultiAgentScaffoldV1(workspaceDir) {
  if (process.env.JARVIS_MULTI_AGENT_SCAFFOLD_V1?.trim() !== "1") {
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
    "2026-09-21-multi-agent-scaffold-v1",
  );

  if (!fs.existsSync(configPath) || !fs.existsSync(agentsPath)) {
    console.warn("[multi-agent-v1] config or AGENTS.md missing; skipping");
    return { applied: false, reason: "missing-files" };
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const configBackupPath = path.join(backupDir, "openclaw.json.pre-scaffold");
  const agentsBackupPath = path.join(backupDir, "AGENTS.md.pre-scaffold");
  if (!fs.existsSync(configBackupPath)) fs.copyFileSync(configPath, configBackupPath);
  if (!fs.existsSync(agentsBackupPath)) fs.copyFileSync(agentsPath, agentsBackupPath);

  const originalConfigText = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(originalConfigText);
  const originalPrimaryModel = cfg.agents?.defaults?.model?.primary;
  const originalMainThinking = cfg.agents?.entries?.main?.thinkingDefault;
  const originalDelegationMode = cfg.agents?.defaults?.subagents?.delegationMode;
  const originalMaxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth;

  if (!cfg.agents?.entries?.main) {
    throw new Error("main agent entry missing; refusing scaffold mutation");
  }

  const agentRoot = process.env.JARVIS_AGENT_WORKSPACES_DIR?.trim() || "/data/agent-workspaces";
  const seats = [
    { id: "forum-01", label: "Forum 1", role: "forum" },
    { id: "forum-02", label: "Forum 2", role: "forum" },
    { id: "forum-03", label: "Forum 3", role: "forum" },
    { id: "counsel-01", label: "Counsel 1", role: "counsel" },
    { id: "counsel-02", label: "Counsel 2", role: "counsel" },
    { id: "counsel-03", label: "Counsel 3", role: "counsel" },
    { id: "research-01", label: "Research 1", role: "research" },
    { id: "research-02", label: "Research 2", role: "research" },
  ];
  const stableIds = seats.map((seat) => seat.id);
  const allAgentIds = ["main", ...stableIds];

  const commonUser = [
    "# USER.md",
    "",
    "You serve the owner through Jarvis.",
    "Personal context is supplied only in the scoped task/case packet.",
    "Do not create or maintain a parallel personal-memory profile.",
    "",
  ].join("\n");

  const forumRules = [
    "# Forum Adviser Rules",
    "",
    "- You are a Forum adviser seat, not Jarvis and not the final authority.",
    "- Work from the shared case packet/evidence packet supplied by Jarvis.",
    "- One adviser pass by default; a second pass only when Jarvis sends a material contradiction or gap.",
    "- Do not invoke Counsel. Only the owner may authorize Counsel.",
    "- Do not spawn subagents or do independent browsing/research.",
    "- If evidence is missing, send a concise research request to agent:main:main and continue only with clearly marked assumptions.",
    "- When directly addressed, answer as this seat, not as Jarvis and not as a synthetic consensus.",
    "- Operational execution belongs to dedicated operator agents, not Forum advisers.",
    "",
  ].join("\n");

  const counselRules = [
    "# Counsel Adviser Rules",
    "",
    "- You are a Counsel seat in the explicitly user-invoked heavyweight room.",
    "- Never self-invoke Counsel or widen scope beyond the user-authorized Counsel case.",
    "- Use the inherited Forum/case dossier, but challenge it and request delta/deeper research through Jarvis when needed.",
    "- Do not recursively spawn agents or conduct independent web research.",
    "- Counsel 1 is the final-synthesizer seat; Counsel 2 and Counsel 3 are independent adviser seats.",
    "- Final synthesis must preserve material disagreements and evidence uncertainty rather than forcing consensus.",
    "- Follow-up questions in Counsel stay within Counsel until the owner explicitly addresses Jarvis or exits Counsel.",
    "",
  ].join("\n");

  const researchRules = [
    "# Research Worker Rules",
    "",
    "- You are an evidence worker, not an adviser or decision-maker.",
    "- Research the assigned question independently; prioritize primary and authoritative sources.",
    "- Capture dates, citations/links, uncertainty, and contradictions.",
    "- Return a compact evidence packet; do not synthesize the final recommendation.",
    "- Do not spawn agents, send messages, modify config, or perform operational actions.",
    "- Keep no persistent personal memory; use only the supplied scope.",
    "",
  ].join("\n");

  const roleRules = {
    forum: forumRules,
    counsel: counselRules,
    research: researchRules,
  };

  const writeOnce = (filePath, body) => {
    if (fs.existsSync(filePath)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, body.trimEnd() + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  };

  for (const seat of seats) {
    const seatDir = path.join(agentRoot, seat.id);
    fs.mkdirSync(seatDir, { recursive: true, mode: 0o700 });
    writeOnce(
      path.join(seatDir, "SOUL.md"),
      [
        "# " + seat.label,
        "",
        "You are the stable " + seat.label + " backend seat in the Jarvis architecture.",
        "The model occupying this seat may change over time without changing the seat identity.",
        "Never treat a model/provider name as your permanent identity.",
        "",
      ].join("\n"),
    );
    writeOnce(path.join(seatDir, "AGENTS.md"), roleRules[seat.role]);
    writeOnce(path.join(seatDir, "USER.md"), commonUser);
  }

  let configChanged = false;
  if (cfg.agents.ownership === undefined) {
    cfg.agents.ownership = "explicit";
    configChanged = true;
  }
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.systemAgent ??= {};
  if (cfg.agents.defaults.systemAgent.agentId === undefined) {
    cfg.agents.defaults.systemAgent.agentId = "main";
    configChanged = true;
  }
  cfg.agents.entries.main.subagents ??= {};
  const existingMainAllow = Array.isArray(cfg.agents.entries.main.subagents.allowAgents)
    ? cfg.agents.entries.main.subagents.allowAgents
    : [];
  const mergedMainAllow = Array.from(new Set([...existingMainAllow, ...stableIds]));
  if (
    !Array.isArray(cfg.agents.entries.main.subagents.allowAgents) ||
    mergedMainAllow.length !== existingMainAllow.length
  ) {
    cfg.agents.entries.main.subagents.allowAgents = mergedMainAllow;
    configChanged = true;
  }

  const adviserAllow = ["read", "sessions_send", "session_status"];
  const adviserDeny = [
    "sessions_spawn",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "browser",
    "web_search",
    "web_fetch",
    "gateway",
    "cron",
    "exec",
    "process",
    "write",
    "edit",
    "apply_patch",
  ];
  const researchAllow = ["read", "browser", "web_search", "web_fetch"];
  const researchDeny = [
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "gateway",
    "cron",
    "exec",
    "process",
    "write",
    "edit",
    "apply_patch",
  ];

  for (const seat of seats) {
    if (cfg.agents.entries[seat.id]) continue;
    const isResearch = seat.role === "research";
    cfg.agents.entries[seat.id] = {
      name: seat.label,
      workspace: path.join(agentRoot, seat.id),
      identity: { name: seat.label },
      tools: {
        allow: isResearch ? researchAllow : adviserAllow,
        deny: isResearch ? researchDeny : adviserDeny,
      },
    };
    configChanged = true;
  }

  cfg.tools ??= {};
  cfg.tools.agentToAgent ??= {};
  if (cfg.tools.agentToAgent.enabled === undefined) {
    cfg.tools.agentToAgent.enabled = true;
    configChanged = true;
  }
  const existingA2AAllow = Array.isArray(cfg.tools.agentToAgent.allow)
    ? cfg.tools.agentToAgent.allow
    : [];
  const mergedA2AAllow = Array.from(new Set([...existingA2AAllow, ...allAgentIds]));
  if (
    !Array.isArray(cfg.tools.agentToAgent.allow) ||
    mergedA2AAllow.length !== existingA2AAllow.length
  ) {
    cfg.tools.agentToAgent.allow = mergedA2AAllow;
    configChanged = true;
  }

  if (configChanged) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    const validation = childProcess.spawnSync(
      process.execPath,
      ["/openclaw/dist/entry.js", "config", "validate", "--json"],
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (validation.status !== 0) {
      let diagnostic = [validation.stdout || "", validation.stderr || ""].join("\n").trim();
      const secrets = [
        cfg.channels?.telegram?.botToken,
        cfg.gateway?.auth?.token,
        cfg.gateway?.remote?.token,
      ].filter((value) => typeof value === "string" && value.length > 0);
      for (const secret of secrets) diagnostic = diagnostic.split(secret).join("[REDACTED]");
      console.warn("[multi-agent-v1] candidate validation failed: " + diagnostic.slice(0, 3000));
      fs.copyFileSync(configBackupPath, configPath);
      throw new Error("OpenClaw rejected multi-agent scaffold config; restored pre-scaffold config");
    }
  }

  const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const id of stableIds) {
    if (!verified.agents?.entries?.[id]) {
      throw new Error("multi-agent scaffold verification failed: missing " + id);
    }
    if (verified.agents.entries[id].model !== undefined) {
      throw new Error("multi-agent scaffold verification failed: model pinned on " + id);
    }
    if (!verified.agents?.entries?.main?.subagents?.allowAgents?.includes(id)) {
      throw new Error("multi-agent scaffold verification failed: main cannot spawn " + id);
    }
  }
  if (verified.agents?.defaults?.model?.primary !== originalPrimaryModel) {
    throw new Error("multi-agent scaffold changed primary model unexpectedly");
  }
  if (verified.agents?.entries?.main?.thinkingDefault !== originalMainThinking) {
    throw new Error("multi-agent scaffold changed main thinking level unexpectedly");
  }
  if (verified.agents?.defaults?.subagents?.delegationMode !== originalDelegationMode) {
    throw new Error("multi-agent scaffold changed delegation mode unexpectedly");
  }
  if (verified.agents?.defaults?.subagents?.maxSpawnDepth !== originalMaxSpawnDepth) {
    throw new Error("multi-agent scaffold changed max spawn depth unexpectedly");
  }

  const marker = "## Jarvis Multi-Agent Routing v1";
  const routingPolicy = [
    marker,
    "",
    "- Stable backend seats: forum-01/02/03, counsel-01/02/03, research-01/02. Models are replaceable occupants; seat IDs stay stable.",
    "- Direct Jarvis work remains direct-first.",
    "- Research routing: Quick -> research-01; Standard -> research-01 + research-02 independently; Deep -> both, then only targeted gap follow-up if needed.",
    "- Forum runs only when the owner invokes or addresses Forum. Jarvis builds one shared case/evidence packet, invokes the minimum relevant Forum seats, one pass by default, and uses a second round only for a material contradiction or gap. Jarvis/Sol may synthesize Forum when asked; a directly addressed seat answers as itself.",
    "- Forum may recommend Counsel but must never invoke it.",
    "- Counsel runs only after explicit owner authorization. It inherits the structured dossier, performs delta/deeper research as needed through research-01/02, obtains independent Counsel views, and counsel-01 is the final-synthesizer seat. Counsel remains conversational for follow-ups.",
    "- Adviser seats do not privately spawn frontier children. Research is centralized through research-01/02.",
    "- Operational jobs are routed to dedicated operator agents to be created separately with owner approval.",
    "- Material spend-limit increases and meaningful quality-reducing routing changes require owner approval. No numeric spend threshold is invented here.",
    "",
  ].join("\n");

  let agentsText = fs.readFileSync(agentsPath, "utf8");
  const markerCount = (agentsText.match(/## Jarvis Multi-Agent Routing v1/g) || []).length;
  if (markerCount === 0) {
    fs.writeFileSync(
      agentsPath,
      agentsText.trimEnd() + "\n\n" + routingPolicy,
      { encoding: "utf8", mode: 0o600 },
    );
    agentsText = fs.readFileSync(agentsPath, "utf8");
  } else if (markerCount > 1) {
    throw new Error("duplicate Jarvis Multi-Agent Routing v1 markers found");
  }
  if ((agentsText.match(/## Jarvis Multi-Agent Routing v1/g) || []).length !== 1) {
    throw new Error("multi-agent routing policy verification failed");
  }

  console.log("[multi-agent-v1] scaffold applied and verified");
  return { applied: true, backupDir, configChanged };
}

export function applyPrivateWorkspaceSeed(workspaceDir) {
  try {
    applyJarvisOrchestrationPolicyV1(workspaceDir);
  } catch (err) {
    console.warn(`[orchestration-v1] failed: ${String(err)}`);
  }

  try {
    applyJarvisMultiAgentScaffoldV1(workspaceDir);
  } catch (err) {
    console.warn(`[multi-agent-v1] failed: ${String(err)}`);
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
