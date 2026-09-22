import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FACTORY_VERSION = "v1";
const AGENT_ROOT = process.env.JARVIS_AGENT_WORKSPACES_DIR?.trim() || "/data/agent-workspaces";

function stateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw")
  );
}

function workspaceDir() {
  return (
    process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
    process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
    path.join(stateDir(), "workspace")
  );
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(stateDir(), "openclaw.json")
  );
}

function factoryRoot() {
  return path.join(workspaceDir(), "control", "agent-factory");
}

function plansDir() {
  return path.join(factoryRoot(), "plans");
}

function approvalsDir() {
  return path.join(factoryRoot(), "approvals");
}

function auditPath() {
  return path.join(factoryRoot(), "audit.jsonl");
}

function fail(message) {
  throw new Error(message);
}

function ensureDirs() {
  for (const dir of [factoryRoot(), plansDir(), approvalsDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readConfigText() {
  const p = configPath();
  if (!fs.existsSync(p)) fail("OpenClaw config not found");
  return fs.readFileSync(p, "utf8");
}

function atomicWrite(filePath, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode });
  fs.renameSync(tmp, filePath);
}

function writeJson(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value, null, 2) + "\n");
}

function audit(event, details = {}) {
  ensureDirs();
  const safe = {
    at: new Date().toISOString(),
    version: FACTORY_VERSION,
    event,
    ...details,
  };
  fs.appendFileSync(auditPath(), JSON.stringify(safe) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { positional, options };
}

function validateAgentId(agentId) {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(agentId)) {
    fail("Agent id must be 2-32 lowercase letters, numbers, or hyphens");
  }
  if (
    agentId === "main" ||
    agentId.startsWith("forum-") ||
    agentId.startsWith("counsel-") ||
    agentId.startsWith("research-")
  ) {
    fail("Agent id is reserved by the canonical Jarvis room architecture");
  }
}

const BUILTIN_DANGEROUS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "gateway",
  "cron",
  "automations",
  "secrets",
  "sessions_spawn",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "browser",
  "web_search",
  "web_fetch",
]);

const CORE_DENY = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "gateway",
  "cron",
  "sessions_spawn",
  "sessions_list",
  "sessions_history",
  "sessions_search",
];

function normalizeRequestedTools(raw) {
  if (!raw) return [];
  const tools = String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(tools));
  for (const tool of unique) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tool)) {
      fail("Invalid tool id: " + tool);
    }
    if (tool.includes("*") || tool.startsWith("group:")) {
      fail("Wildcards and tool groups are not allowed in restricted operator plans");
    }
    if (BUILTIN_DANGEROUS.has(tool)) {
      fail("Restricted operator cannot receive core/high-risk tool: " + tool);
    }
  }
  return unique;
}

function permissionTemplate(agentClass, requestedTools) {
  if (agentClass === "adviser") {
    if (requestedTools.length) fail("Adviser class does not accept custom tools");
    return {
      allow: ["sessions_send", "session_status"],
      deny: [...CORE_DENY, "browser", "web_search", "web_fetch"],
    };
  }
  if (agentClass === "research") {
    if (requestedTools.length) fail("Research class does not accept custom tools");
    return {
      allow: ["browser", "web_search", "web_fetch"],
      deny: [...CORE_DENY, "sessions_send"],
    };
  }
  if (agentClass === "operator") {
    if (!requestedTools.length) {
      fail("Restricted operator requires at least one explicit concrete connector/tool id");
    }
    return {
      allow: ["session_status", ...requestedTools],
      deny: [...CORE_DENY, "sessions_send", "browser", "web_search", "web_fetch"],
    };
  }
  fail("Class must be adviser, research, or operator");
}

function planFile(planId) {
  return path.join(plansDir(), planId + ".json");
}

function approvalFile(planId) {
  return path.join(approvalsDir(), planId + ".json");
}

function createPlan(agentId, agentClass, displayName, requestedTools) {
  ensureDirs();
  validateAgentId(agentId);
  const configText = readConfigText();
  const cfg = JSON.parse(configText);
  if (cfg.agents?.entries?.[agentId]) fail("Agent id already exists");

  const tools = permissionTemplate(agentClass, requestedTools);
  const planCore = {
    factoryVersion: FACTORY_VERSION,
    agentId,
    class: agentClass,
    displayName: displayName || agentId,
    workspace: path.join(AGENT_ROOT, agentId),
    tools,
    modelPinned: false,
    bindingsCreated: false,
    credentialsCreated: false,
    baseConfigHash: sha256(configText),
  };
  const createdAt = new Date().toISOString();
  const planId = sha256(JSON.stringify(planCore) + createdAt).slice(0, 12);
  const plan = { planId, createdAt, ...planCore };
  writeJson(planFile(planId), plan);
  audit("plan-created", {
    planId,
    agentId,
    class: agentClass,
    allow: tools.allow,
    deny: tools.deny,
  });
  return plan;
}

function approvePlan(planId, ownerConfirmed) {
  ensureDirs();
  if (!ownerConfirmed) {
    fail("Owner confirmation flag is required; approval must follow an explicit owner instruction naming this plan");
  }
  const p = planFile(planId);
  if (!fs.existsSync(p)) fail("Unknown plan id");
  const plan = JSON.parse(fs.readFileSync(p, "utf8"));
  const now = Date.now();
  const approval = {
    planId,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    singleUse: true,
  };
  writeJson(approvalFile(planId), approval);
  audit("plan-approved", { planId, agentId: plan.agentId, class: plan.class });
  return approval;
}

function validateOpenClawConfig() {
  const result = childProcess.spawnSync(
    process.execPath,
    ["/openclaw/dist/entry.js", "config", "validate", "--json"],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir(),
        OPENCLAW_WORKSPACE_DIR: workspaceDir(),
        OPENCLAW_CONFIG_PATH: configPath(),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    fail("OpenClaw rejected candidate config");
  }
}

function writeSeatBootstrap(plan) {
  const dir = plan.workspace;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const soul = [
    "# " + plan.displayName,
    "",
    "You are a permanent specialist agent created by the Jarvis Agent Factory.",
    "Your permissions are deliberately bounded by your assigned class.",
    "Do not widen your own permissions, create credentials, or create child agents.",
    "",
  ].join("\n");
  const agents = [
    "# Agent Factory Rules",
    "",
    "- Class: " + plan.class,
    "- Work only within the task scope supplied by Jarvis or the owner.",
    "- Do not create or retain a parallel personal profile of the owner.",
    "- Do not request or store API keys, passwords, bot tokens, or provider credentials.",
    "- Do not modify OpenClaw configuration or infrastructure.",
    "- Do not spawn subagents.",
    "- If a missing permission is required, stop and request an owner-approved permission review.",
    "",
  ].join("\n");
  const user = [
    "# USER.md",
    "",
    "You serve the owner through Jarvis.",
    "Personal context is supplied only when relevant to the scoped task.",
    "Do not create persistent personal memory unless explicitly designed and approved for this agent.",
    "",
  ].join("\n");

  atomicWrite(path.join(dir, "SOUL.md"), soul);
  atomicWrite(path.join(dir, "AGENTS.md"), agents);
  atomicWrite(path.join(dir, "USER.md"), user);
}

function applyPlan(planId) {
  ensureDirs();
  const p = planFile(planId);
  const a = approvalFile(planId);
  if (!fs.existsSync(p)) fail("Unknown plan id");
  if (!fs.existsSync(a)) fail("Plan has no owner approval");

  const plan = JSON.parse(fs.readFileSync(p, "utf8"));
  const approval = JSON.parse(fs.readFileSync(a, "utf8"));
  if (approval.planId !== planId) fail("Approval does not match plan");
  if (Date.parse(approval.expiresAt) < Date.now()) fail("Approval expired; re-approve the plan");

  const originalText = readConfigText();
  if (sha256(originalText) !== plan.baseConfigHash) {
    fail("OpenClaw config changed since this plan was created; create a fresh plan");
  }

  const cfg = JSON.parse(originalText);
  cfg.agents ??= {};
  cfg.agents.entries ??= {};
  if (cfg.agents.entries[plan.agentId]) fail("Agent id now exists; refusing overwrite");
  if (!cfg.agents.entries.main) fail("Main Jarvis agent entry missing");

  writeSeatBootstrap(plan);

  cfg.agents.ownership ??= "explicit";
  cfg.agents.entries[plan.agentId] = {
    name: plan.displayName,
    workspace: plan.workspace,
    identity: { name: plan.displayName },
    subagents: { allowAgents: [] },
    tools: {
      allow: plan.tools.allow,
      deny: plan.tools.deny,
    },
  };

  cfg.agents.entries.main.subagents ??= {};
  const mainAllow = Array.isArray(cfg.agents.entries.main.subagents.allowAgents)
    ? cfg.agents.entries.main.subagents.allowAgents
    : [];
  cfg.agents.entries.main.subagents.allowAgents = Array.from(
    new Set([...mainAllow, plan.agentId]),
  );

  cfg.tools ??= {};
  cfg.tools.agentToAgent ??= {};
  if (cfg.tools.agentToAgent.enabled === undefined) cfg.tools.agentToAgent.enabled = true;
  const a2a = Array.isArray(cfg.tools.agentToAgent.allow)
    ? cfg.tools.agentToAgent.allow
    : [];
  cfg.tools.agentToAgent.allow = Array.from(new Set([...a2a, "main", plan.agentId]));

  const date = new Date().toISOString().slice(0, 10);
  const backupDir = path.join(
    workspaceDir(),
    "memory",
    ".seed-backups",
    date + "-agent-factory-v1",
    planId,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, "openclaw.json.pre-apply");
  atomicWrite(backupPath, originalText);

  try {
    atomicWrite(configPath(), JSON.stringify(cfg, null, 2) + "\n");
    validateOpenClawConfig();
    const verified = JSON.parse(readConfigText());
    const entry = verified.agents?.entries?.[plan.agentId];
    if (!entry) fail("Applied config is missing new agent");
    if (entry.model !== undefined) fail("Factory unexpectedly pinned a model");
    if (JSON.stringify(entry.tools?.allow ?? []) !== JSON.stringify(plan.tools.allow)) {
      fail("Applied allowlist differs from approved plan");
    }
    if (JSON.stringify(entry.tools?.deny ?? []) !== JSON.stringify(plan.tools.deny)) {
      fail("Applied denylist differs from approved plan");
    }
  } catch (err) {
    atomicWrite(configPath(), originalText);
    audit("apply-rolled-back", { planId, agentId: plan.agentId });
    throw err;
  }

  fs.unlinkSync(a);
  audit("plan-applied", {
    planId,
    agentId: plan.agentId,
    class: plan.class,
    gatewayRestarted: false,
  });

  return {
    ok: true,
    planId,
    agentId: plan.agentId,
    class: plan.class,
    modelPinned: false,
    bindingCreated: false,
    credentialsCreated: false,
    gatewayRestarted: false,
    backupPath,
  };
}

function status(planId) {
  const p = planFile(planId);
  const a = approvalFile(planId);
  return {
    planExists: fs.existsSync(p),
    approvalExists: fs.existsSync(a),
    plan: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null,
    approval: fs.existsSync(a) ? JSON.parse(fs.readFileSync(a, "utf8")) : null,
  };
}

function skillText() {
  return [
    "---",
    "name: jarvis-agent-factory",
    "description: Plan and create permanent specialist Jarvis agents using narrow permission classes and explicit owner approval.",
    "user-invocable: false",
    "---",
    "",
    "# Jarvis Agent Factory v1",
    "",
    "Use this only for durable specialist/operator identities. Do not create a permanent agent merely because a task is difficult; ordinary work follows the direct-first orchestration policy.",
    "",
    "## Approval boundary",
    "",
    "- You may create a factory PLAN without owner approval.",
    "- Never approve or apply a plan unless the owner explicitly approves that exact plan ID in the current conversation.",
    "- Approval is single-use and expires after 30 minutes.",
    "- Do not interpret silence, prior general enthusiasm, or an unrelated approval as approval of a new plan.",
    "",
    "## Permission classes",
    "",
    "- adviser: bounded reasoning seat; can report to Jarvis, no filesystem, browser, research, shell, gateway, cron, or child spawning.",
    "- research: evidence worker; browser/web research only, no filesystem, messaging, shell, gateway, cron, config mutation, or child spawning.",
    "- operator: restricted connector operator. Every connector/tool must be named explicitly in the plan. Wildcards, tool groups, browser, shell, filesystem mutation, gateway, cron, secrets, and child spawning are refused by v1.",
    "",
    "If a future role genuinely needs privileged shell, gateway, broad browser automation, credentials, or infrastructure authority, do not bypass this factory. Create a separate owner-reviewed architecture change.",
    "",
    "## Secret rule",
    "",
    "The factory never creates, reads, copies, or binds credentials. Use the dedicated secret vault or connector authorization path separately after the agent exists.",
    "",
    "## Commands",
    "",
    "Plan: node /app/src/jarvis-agent-factory.js plan <agent-id> <adviser|research|operator> [--name <display-name>] [--allow <tool1,tool2>]",
    "Approve after explicit owner approval: node /app/src/jarvis-agent-factory.js approve <plan-id> --owner-confirmed",
    "Apply: node /app/src/jarvis-agent-factory.js apply <plan-id>",
    "Inspect: node /app/src/jarvis-agent-factory.js status <plan-id>",
    "",
    "After apply, report the exact class and allowlist to the owner. Do not silently restart the gateway; schedule any required reload/restart through the normal bounded recovery path.",
    "",
  ].join("\n");
}

export function installJarvisAgentFactoryV1(targetWorkspaceDir) {
  if (process.env.JARVIS_MULTI_AGENT_SCAFFOLD_V1 !== "1") {
    return { applied: false, reason: "multi-agent-disabled" };
  }
  const dir = targetWorkspaceDir || workspaceDir();
  const skillPath = path.join(dir, "skills", "jarvis-agent-factory", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  atomicWrite(skillPath, skillText());
  ensureDirs();
  console.log("[agent-factory-v1] installed");
  return { applied: true, skillPath };
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0];

  if (command === "plan") {
    const agentId = positional[1];
    const agentClass = positional[2];
    if (!agentId || !agentClass) fail("Usage: plan <agent-id> <class>");
    const requestedTools = normalizeRequestedTools(options.allow);
    const plan = createPlan(agentId, agentClass, options.name, requestedTools);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }

  if (command === "approve") {
    const planId = positional[1];
    if (!planId) fail("Usage: approve <plan-id> --owner-confirmed");
    const approval = approvePlan(planId, options["owner-confirmed"] === true);
    process.stdout.write(JSON.stringify(approval, null, 2) + "\n");
    return;
  }

  if (command === "apply") {
    const planId = positional[1];
    if (!planId) fail("Usage: apply <plan-id>");
    const result = applyPlan(planId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (command === "status") {
    const planId = positional[1];
    if (!planId) fail("Usage: status <plan-id>");
    process.stdout.write(JSON.stringify(status(planId), null, 2) + "\n");
    return;
  }

  fail("Commands: plan, approve, apply, status");
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write("[agent-factory-v1] " + String(err?.message || err) + "\n");
    process.exit(1);
  });
}
