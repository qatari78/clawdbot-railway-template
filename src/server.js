import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";
import { applyPrivateWorkspaceSeed } from "./private-workspace-seed.js";
import { installJarvisAgentFactoryV1 } from "./jarvis-agent-factory.js";
import { runJarvisAgentSmokeV1 } from "./jarvis-agent-smoke.js";
import { applyJarvisAdviserMemoryV1 } from "./jarvis-adviser-memory.js";
import { runJarvisAdviserMemoryCommissioningV1 } from "./jarvis-adviser-memory-commissioning.js";
import { runJarvisSecurityAuditV1 } from "./jarvis-security-audit.js";
import { runOpenRouterKeyAuditV1 } from "./openrouter-key-audit.js";
import { applyJarvisResearchSystemV1 } from "./jarvis-research-system-v1.js";
import { applyJarvisSeatConfigV1 } from "./jarvis-seat-config-v1.js";
import { runJarvisResearchCommissioningV1 } from "./jarvis-research-commissioning.js";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
  // Avoid forwarding legacy variables into OpenClaw subprocesses.
  // OpenClaw logs a warning when deprecated CLAWDBOT_* variables are present.
  delete process.env[oldKey];
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Separate machine credential for automated backup export.
// Human/admin access continues to use SETUP_PASSWORD.
const BACKUP_EXPORT_TOKEN = process.env.BACKUP_EXPORT_TOKEN?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to root.
      const paths = ["/healthz", "/openclaw", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function launchJarvisAgentSmokeV1() {
  void runJarvisAgentSmokeV1({
    workspaceDir: WORKSPACE_DIR,
    runCmd,
    clawArgs,
    openclawNode: OPENCLAW_NODE,
  }).catch((err) => {
    console.warn(`[agent-smoke-v1] failed: ${String(err)}`);
  });
}

function launchJarvisResearchCommissioningV1() {
  void runJarvisResearchCommissioningV1({
    workspaceDir: WORKSPACE_DIR,
    runCmd,
    clawArgs,
    openclawNode: OPENCLAW_NODE,
  }).catch((err) => {
    console.warn(`[research-commission-v1] failed: ${String(err)}`);
  });
}

function launchJarvisAdviserMemoryCommissioningV1() {
  void runJarvisAdviserMemoryCommissioningV1({
    workspaceDir: WORKSPACE_DIR,
    configPath: configPath(),
    runCmd,
    clawArgs,
    openclawNode: OPENCLAW_NODE,
  }).catch((err) => {
    console.warn(`[adviser-memory-test-v1] failed: ${String(err)}`);
  });
}

function launchJarvisSecurityAuditV1() {
  void runJarvisSecurityAuditV1({
    workspaceDir: WORKSPACE_DIR,
    runCmd,
    clawArgs,
    openclawNode: OPENCLAW_NODE,
  }).catch((err) => {
    console.warn(`[security-audit-v1] failed: ${String(err)}`);
  });
}

function launchOpenRouterKeyAuditV1() {
  void runOpenRouterKeyAuditV1({
    stateDir: STATE_DIR,
    configPath: configPath(),
    workspaceDir: WORKSPACE_DIR,
    runCmd,
    clawArgs,
    openclawNode: OPENCLAW_NODE,
    gatewayToken: OPENCLAW_GATEWAY_TOKEN,
    gatewayPort: INTERNAL_GATEWAY_PORT,
  }).catch((err) => {
    console.warn(`[openrouter-key-audit-v1] failed: ${String(err)}`);
  });
}


async function runJarvisMainSessionRecoveryV1() {
  const markerPath = path.join(STATE_DIR, ".jarvis-main-session-recovery-v1.json");
  if (fs.existsSync(markerPath)) {
    console.log("[main-session-recovery-v1] prior attempt exists; skipping");
    return;
  }

  const startedAt = new Date().toISOString();
  let record;
  try {
    const params = JSON.stringify({ key: "agent:main:main", reason: "reset" });
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["gateway", "call", "sessions.reset", "--params", params, "--json", "--timeout", "60000"]),
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 70_000,
      },
    );
    const output = redactSecrets(r.output || "").trim();
    record = { version: 1, startedAt, finishedAt: new Date().toISOString(), ok: true, output };
    console.log("[main-session-recovery-v1] reset completed " + JSON.stringify(record));
  } catch (err) {
    record = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: redactSecrets(String(err)),
    };
    console.error("[main-session-recovery-v1] reset failed " + JSON.stringify(record));
  }

  try {
    fs.writeFileSync(markerPath, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn("[main-session-recovery-v1] failed to persist marker: " + String(err));
  }
}


function c1EstimateTokensFromChars(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}

function c1EstimateUnknownChars(value) {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

function c1EstimateMessageChars(message) {
  if (!message || typeof message !== "object" || message.excludeFromContext === true) return 0;
  const role = message.role;
  const content = message.content;

  const estimateBlocks = (blocks, toolResult = false) => {
    let chars = 0;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        chars += toolResult ? block.text.length * 2 : block.text.length;
      } else if (block && typeof block === "object" && block.type === "image") {
        chars += toolResult ? 16000 : 8000;
      } else {
        chars += c1EstimateUnknownChars(block) * (toolResult ? 2 : 1);
      }
    }
    return chars;
  };

  if (role === "user" || role === "custom") {
    if (typeof content === "string") return content.length;
    return estimateBlocks(content, false);
  }

  if (role === "assistant") {
    let chars = 0;
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        chars += block.text.length;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        chars += block.thinking.length;
      } else if (block.type === "toolCall") {
        chars += c1EstimateUnknownChars(block.arguments ?? {});
      } else {
        chars += c1EstimateUnknownChars(block);
      }
    }
    return chars;
  }

  if (role === "toolResult" || role === "tool" || message.type === "toolResult") {
    const blocks =
      typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    return estimateBlocks(blocks, true);
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    return typeof message.summary === "string" ? message.summary.length : 0;
  }

  return 256;
}

function c1FindNumeric(value, preferredKeys) {
  if (!value || typeof value !== "object") return null;
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = c1FindNumeric(child, preferredKeys);
      if (found !== null) return found;
    }
  }
  return null;
}

function c1ActiveMemoryChars(prompt) {
  if (typeof prompt !== "string") return 0;
  const open = "<active_memory_plugin>";
  const close = "</active_memory_plugin>";
  const start = prompt.lastIndexOf(open);
  if (start < 0) return 0;
  const end = prompt.indexOf(close, start + open.length);
  if (end < 0) return 0;
  const blockEnd = end + close.length;
  const header = "Context:\n";
  const headerStart = Math.max(0, start - header.length);
  return prompt.slice(headerStart, start) === header ? blockEnd - headerStart : blockEnd - start;
}

function c1WorkspaceFileSizes(root) {
  const files = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full) || ".";
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        files.push({ path: rel, bytes: fs.statSync(full).size });
      } catch {}
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}


function c1ParseInjectedProjectFiles(systemPrompt, workspaceFiles) {
  if (typeof systemPrompt !== "string" || !systemPrompt) return [];
  const marker = "# Project Context";
  const markerIndex = systemPrompt.indexOf(marker);
  if (markerIndex < 0) return [];

  const silentIndex = systemPrompt.indexOf("\n## Silent Replies\n", markerIndex);
  const section = systemPrompt.slice(
    markerIndex,
    silentIndex >= 0 ? silentIndex : systemPrompt.length,
  );

  const headingRe = /^## (.+\.md)\r?$/gmu;
  const headings = [];
  let match;
  while ((match = headingRe.exec(section)) !== null) {
    headings.push({
      index: match.index,
      end: match.index + match[0].length,
      pathLabel: String(match[1] || ""),
    });
  }

  return headings.map((heading, index) => {
    const nextIndex = headings[index + 1]?.index ?? section.length;
    let payload = section.slice(heading.end, nextIndex);
    payload = payload.replace(/^\r?\n\r?\n/u, "").replace(/(?:\r?\n)+$/u, "");

    let relativePath = heading.pathLabel
      .replace(/^\$WORKSPACE_DIR[\\/]/u, "")
      .replace(/^\/data\/workspace\//u, "")
      .replace(/\\/g, "/");
    if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      relativePath = path.basename(relativePath);
    }

    const liveEntry =
      workspaceFiles.find((entry) => entry.path === relativePath) ??
      workspaceFiles.find((entry) => path.basename(entry.path) === path.basename(relativePath));
    let rawChars = 0;
    if (liveEntry) {
      const full = path.resolve(WORKSPACE_DIR, liveEntry.path);
      const root = path.resolve(WORKSPACE_DIR);
      if (full === root || full.startsWith(root + path.sep)) {
        try {
          rawChars = fs.readFileSync(full, "utf8").length;
        } catch {}
      }
    }

    return {
      name: relativePath || path.basename(heading.pathLabel),
      rawChars,
      injectedChars: payload.length,
      tokensApprox: c1EstimateTokensFromChars(payload.length),
      truncated: /\btruncated\b/iu.test(payload) ? 1 : 0,
      missing: /^\[MISSING\]/u.test(payload) ? 1 : 0,
    };
  });
}

function c1ResolveBootstrapLimits() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {}
  const defaults = cfg?.agents?.defaults ?? {};
  const main = cfg?.agents?.entries?.main ?? {};
  const positive = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  return {
    bootstrapMaxChars: positive(main.bootstrapMaxChars ?? defaults.bootstrapMaxChars, 20000),
    bootstrapTotalMaxChars: positive(
      main.bootstrapTotalMaxChars ?? defaults.bootstrapTotalMaxChars,
      60000,
    ),
    userBootstrapMaxChars: 4000,
  };
}

function c1ResolveSkillsPrompt(metadata, prompts) {
  const candidates = [
    metadata?.prompting?.skillsPrompt,
    prompts?.skillsPrompt,
  ];
  return candidates.find((value) => typeof value === "string") ?? "";
}

function c1ToolSchemaStatsFromTools(tools) {
  const rows = Array.isArray(tools) ? tools : [];
  let schemaChars = 0;
  for (const tool of rows) {
    try {
      schemaChars += JSON.stringify(tool?.parameters ?? {}).length;
    } catch {}
  }
  return { count: rows.length, schemaChars };
}

function c1MessageRowsFromBranch(branch) {
  const entries = Array.isArray(branch?.entries) ? branch.entries : [];
  return entries
    .filter((entry) => entry?.type === "message" && entry?.message)
    .map((entry) => entry.message);
}

async function runC1ContextDiagnosticV1(measurement = "current") {
  const sessionKey = "agent:main:main";
  const outputName = "c1-context-diagnostic-v1";
  const trajectoryWorkspace = path.join(os.tmpdir(), "c1-trajectory-workspace-v1");
  const outputDir = path.join(trajectoryWorkspace, ".openclaw", "trajectory-exports", outputName);
  let stage = "prepare";

  try {
    fs.rmSync(trajectoryWorkspace, { recursive: true, force: true });
    fs.mkdirSync(trajectoryWorkspace, { recursive: true, mode: 0o700 });

    stage = "export";
    const exportResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "sessions", "export-trajectory",
        "--session-key", sessionKey,
        "--agent", "main",
        "--workspace", trajectoryWorkspace,
        "--output", outputName,
        "--json",
      ]),
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 120_000,
      },
    );
    if (exportResult.code !== 0) throw new Error("trajectory export failed");

    stage = "parse-transcript";
    const branchPath = path.join(outputDir, "session-branch.json");
    const branch = fs.existsSync(branchPath)
      ? JSON.parse(fs.readFileSync(branchPath, "utf8"))
      : {};
    const messages = c1MessageRowsFromBranch(branch);
    const transcriptChars = messages.reduce(
      (sum, message) => sum + c1EstimateMessageChars(message),
      0,
    );

    stage = "context-command";
    const runId = "c1-context-" + (process.env.RAILWAY_DEPLOYMENT_ID || process.pid);
    const commandParams = {
      sessionKey,
      agentId: "main",
      message: "/context json",
      deliver: false,
      idempotencyKey: runId,
    };
    const commandResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "gateway",
        "call",
        "chat.send",
        "--params",
        JSON.stringify(commandParams),
        "--expect-final",
        "--timeout",
        "30000",
        "--json",
      ]),
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 45_000,
      },
    );
    if (commandResult.code !== 0) throw new Error("context command failed");

    stage = "context-history";
    const historyParams = {
      sessionKey,
      agentId: "main",
      limit: 50,
      maxChars: 131072,
    };
    const historyResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "gateway",
        "call",
        "chat.history",
        "--params",
        JSON.stringify(historyParams),
        "--timeout",
        "10000",
        "--json",
      ]),
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 20_000,
      },
    );
    if (historyResult.code !== 0) throw new Error("context history failed");

    stage = "parse-context-history";
    const historyPayload = JSON.parse(historyResult.output || "{}");
    const historyMessages = Array.isArray(historyPayload?.messages)
      ? historyPayload.messages
      : [];
    const collectText = (value, depth = 0) => {
      if (depth > 10 || value == null) return [];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) {
        return value.flatMap((item) => collectText(item, depth + 1));
      }
      if (typeof value === "object") {
        return Object.values(value).flatMap((item) => collectText(item, depth + 1));
      }
      return [];
    };
    const parseContextPayloadFromValue = (value) => {
      for (const candidateText of collectText(value)) {
        const text = candidateText.trim();
        if (!text.startsWith("{")) continue;
        try {
          const candidate = JSON.parse(text);
          if (candidate?.report && candidate?.session) return candidate;
        } catch {}
      }
      return null;
    };

    const c1HistoryRowShape = (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return { kind: Array.isArray(message) ? "array" : typeof message };
      }
      const meta =
        message.__openclaw &&
        typeof message.__openclaw === "object" &&
        !Array.isArray(message.__openclaw)
          ? message.__openclaw
          : {};
      const content = message.content;
      const textLengths = [];
      if (typeof message.text === "string") textLengths.push(message.text.length);
      if (typeof content === "string") textLengths.push(content.length);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          if (typeof block.text === "string") textLengths.push(block.text.length);
          if (typeof block.content === "string") textLengths.push(block.content.length);
        }
      }
      return {
        role: typeof message.role === "string" ? message.role : null,
        keys: Object.keys(message).sort(),
        metaKeys: Object.keys(meta).sort(),
        id: typeof meta.id === "string" ? meta.id : null,
        idempotencyKey:
          typeof meta.idempotencyKey === "string" ? meta.idempotencyKey : null,
        truncated: meta.truncated === true ? 1 : 0,
        reason: typeof meta.reason === "string" ? meta.reason : null,
        contentKind: Array.isArray(content) ? "array" : typeof content,
        contentBlocks: Array.isArray(content) ? content.length : null,
        textLengths,
      };
    };
    console.log(
      "[c1-history-shape-v1] " +
        JSON.stringify({
          historyPayloadKeys:
            historyPayload && typeof historyPayload === "object" && !Array.isArray(historyPayload)
              ? Object.keys(historyPayload).sort()
              : [],
          historyMessages: historyMessages.length,
          rows: historyMessages.slice(-12).map(c1HistoryRowShape),
        }),
    );

    const assistantMessages = historyMessages
      .slice()
      .reverse()
      .filter(
        (message) =>
          message &&
          typeof message === "object" &&
          message.role === "assistant",
      );

    let contextPayload = null;
    let fullMessageLookupUsed = false;
    for (const message of assistantMessages) {
      contextPayload = parseContextPayloadFromValue(message);
      if (contextPayload) break;
    }

    if (!contextPayload) {
      const matchingTruncated = assistantMessages.find((message) => {
        const meta =
          message?.__openclaw &&
          typeof message.__openclaw === "object" &&
          !Array.isArray(message.__openclaw)
            ? message.__openclaw
            : {};
        return (
          typeof meta.id === "string" &&
          meta.truncated === true &&
          (meta.idempotencyKey === runId || meta.reason === "oversized")
        );
      });
      const fallbackTruncated =
        matchingTruncated ??
        assistantMessages.find((message) => {
          const meta =
            message?.__openclaw &&
            typeof message.__openclaw === "object" &&
            !Array.isArray(message.__openclaw)
              ? message.__openclaw
              : {};
          return typeof meta.id === "string" && meta.truncated === true;
        });
      const messageId = fallbackTruncated?.__openclaw?.id;
      if (typeof messageId !== "string" || !messageId) {
        throw new Error("context history JSON missing");
      }

      stage = "context-message-get";
      const fullMessageResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "gateway",
          "call",
          "chat.message.get",
          "--params",
          JSON.stringify({
            sessionKey,
            agentId: "main",
            messageId,
            maxChars: 2_000_000,
          }),
          "--timeout",
          "10000",
          "--json",
        ]),
        {
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: STATE_DIR,
            OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          },
          timeoutMs: 20_000,
        },
      );
      if (fullMessageResult.code !== 0) {
        throw new Error("context full-message lookup failed");
      }

      stage = "parse-context-message-get";
      const fullMessagePayload = JSON.parse(fullMessageResult.output || "{}");
      if (fullMessagePayload?.ok !== true || !fullMessagePayload?.message) {
        throw new Error("context full-message unavailable");
      }
      contextPayload = parseContextPayloadFromValue(fullMessagePayload.message);
      if (!contextPayload) {
        throw new Error("context full-message JSON missing");
      }
      fullMessageLookupUsed = true;
    }

    const report = contextPayload.report;
    const session = contextPayload.session;
    const injectedRows = Array.isArray(report.injectedWorkspaceFiles)
      ? report.injectedWorkspaceFiles.map((file) => ({
          name: String(file?.name ?? path.basename(String(file?.path ?? ""))),
          path: String(file?.path ?? ""),
          rawChars: Number(file?.rawChars ?? 0),
          injectedChars: Number(file?.injectedChars ?? 0),
          tokensApprox: c1EstimateTokensFromChars(Number(file?.injectedChars ?? 0)),
          truncated: file?.truncated === true ? 1 : 0,
          missing: file?.missing === true ? 1 : 0,
        }))
      : [];
    const injectedCharsTotal = injectedRows.reduce(
      (sum, row) => sum + row.injectedChars,
      0,
    );
    const skillsChars = Number(report?.skills?.promptChars ?? 0);
    const toolSchemaChars = Number(report?.tools?.schemaChars ?? 0);
    const systemPromptChars = Number(report?.systemPrompt?.chars ?? 0);
    const projectContextChars = Number(report?.systemPrompt?.projectContextChars ?? 0);
    const nonProjectContextChars = Number(report?.systemPrompt?.nonProjectContextChars ?? 0);
    const currentTurnPromptChars = Number(report?.currentTurn?.promptChars ?? 0);
    const runtimeContextChars = Number(report?.currentTurn?.runtimeContextChars ?? 0);
    const modelOnlyPromptChars = Number(report?.currentTurn?.modelOnlyPromptChars ?? 0);
    const setupTrackedChars = systemPromptChars + toolSchemaChars;
    const currentTrackedChars =
      setupTrackedChars +
      currentTurnPromptChars +
      runtimeContextChars +
      modelOnlyPromptChars;

    console.log(
      "[c1-context-v1] " +
        JSON.stringify({
          version: 12,
          measurement,
          commandPath: "gateway-chat-history-message-get-context-json",
          fullMessageLookupUsed: fullMessageLookupUsed ? 1 : 0,
          modelTurnSubmitted: 0,
          reportSource: String(report?.source ?? "unknown"),
          source: {
            systemPrompt: {
              chars: systemPromptChars,
              projectContextChars,
              nonProjectContextChars,
              tokensApprox: c1EstimateTokensFromChars(systemPromptChars),
            },
            skillsPrompt: {
              chars: skillsChars,
              tokensApprox: c1EstimateTokensFromChars(skillsChars),
              count: Array.isArray(report?.skills?.entries) ? report.skills.entries.length : 0,
            },
            toolSchemas: {
              chars: toolSchemaChars,
              tokensApprox: c1EstimateTokensFromChars(toolSchemaChars),
              count: Array.isArray(report?.tools?.entries) ? report.tools.entries.length : 0,
            },
            injectedWorkspaceFiles: injectedRows,
            injectedWorkspaceFilesTotal: {
              chars: injectedCharsTotal,
              tokensApprox: c1EstimateTokensFromChars(injectedCharsTotal),
            },
            currentTurn: {
              promptChars: currentTurnPromptChars,
              runtimeContextChars,
              modelOnlyPromptChars,
            },
            transcript: {
              chars: transcriptChars,
              tokensApprox: c1EstimateTokensFromChars(transcriptChars),
              messages: messages.length,
            },
          },
          session: {
            totalTokens: Number(session?.totalTokens ?? 0),
            inputTokens: Number(session?.inputTokens ?? 0),
            outputTokens: Number(session?.outputTokens ?? 0),
            contextTokens: Number(session?.contextTokens ?? 0),
          },
          totals: {
            setupTrackedChars,
            setupTrackedTokensApprox: c1EstimateTokensFromChars(setupTrackedChars),
            currentTrackedChars,
            currentTrackedTokensApprox: c1EstimateTokensFromChars(currentTrackedChars),
          },
        }),
    );
    return true;
  } catch (err) {
    console.error(
      "[c1-context-v1] failed=" +
        JSON.stringify({
          stage,
          errorClass: err?.constructor?.name || "Error",
        }),
    );
    return false;
  } finally {
    try {
      fs.rmSync(trajectoryWorkspace, { recursive: true, force: true });
    } catch {}
  }
}



function b8ParseJsonLoose(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trimStart() || "";
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {}
  }
  return null;
}

function b8CollectKeyValues(value, key, out = [], depth = 0) {
  if (depth > 10 || value == null || out.length >= 32) return out;
  if (Array.isArray(value)) {
    for (const item of value) b8CollectKeyValues(item, key, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) out.push(entryValue);
    if (out.length >= 32) break;
    b8CollectKeyValues(entryValue, key, out, depth + 1);
  }
  return out;
}

function b8CollectMemoryRows(value, out = [], depth = 0) {
  if (depth > 10 || value == null || out.length >= 64) return out;
  if (Array.isArray(value)) {
    for (const item of value) b8CollectMemoryRows(item, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  const row = value;
  if (
    Number.isFinite(row.rssBytes) &&
    Number.isFinite(row.heapUsedBytes)
  ) {
    out.push({
      rssBytes: Number(row.rssBytes),
      heapTotalBytes: Number(row.heapTotalBytes || 0),
      heapUsedBytes: Number(row.heapUsedBytes),
      externalBytes: Number(row.externalBytes || 0),
      arrayBuffersBytes: Number(row.arrayBuffersBytes || 0),
      workerCount: Number.isFinite(row.workerCount) ? Number(row.workerCount) : null,
    });
  }
  for (const child of Object.values(row)) b8CollectMemoryRows(child, out, depth + 1);
  return out;
}

async function runB8MemoryDiagnosticV1() {
  const markerPath = path.join(STATE_DIR, "b8-memory-diagnostic-v1.json");
  if (fs.existsSync(markerPath)) {
    console.log("[b8-memory-v1] skipped marker=present");
    return;
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const runJson = async (args, timeoutMs = 45_000) => {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args), { env, timeoutMs });
    return {
      code: result.code,
      json: result.code === 0 ? b8ParseJsonLoose(result.output) : null,
      outputChars: String(result.output || "").length,
    };
  };

  const startedAt = new Date().toISOString();
  try {
    const stability = await runJson([
      "gateway", "call", "diagnostics.stability",
      "--params", JSON.stringify({ limit: 200 }),
      "--timeout", "15000", "--json",
    ], 25_000);

    const browser = await runJson([
      "browser", "--json", "status",
    ], 30_000);

    const memory = await runJson([
      "memory", "status", "--json",
    ], 60_000);

    const gatewayStatus = await runJson([
      "gateway", "status", "--deep", "--json", "--timeout", "10000",
    ], 45_000);

    const heap = await runJson([
      "gateway", "call", "diagnostics.heapProfile",
      "--params", JSON.stringify({ durationMs: 5000, samplingIntervalBytes: 32768 }),
      "--timeout", "30000", "--json",
    ], 40_000);

    const memoryRows = b8CollectMemoryRows(stability.json);
    const latestMemory = memoryRows.length ? memoryRows[memoryRows.length - 1] : null;
    const rssGapBytes = latestMemory
      ? Math.max(
          0,
          latestMemory.rssBytes -
            latestMemory.heapUsedBytes -
            latestMemory.externalBytes,
        )
      : null;

    const uniqStrings = (values) =>
      Array.from(
        new Set(values.filter((value) => typeof value === "string" && value.length <= 160)),
      ).slice(0, 16);

    const providerCandidates = uniqStrings(b8CollectKeyValues(memory.json, "provider"));
    const modelCandidates = uniqStrings(b8CollectKeyValues(memory.json, "model"));
    const backendCandidates = uniqStrings(b8CollectKeyValues(memory.json, "backend"));
    const browserRunning = b8CollectKeyValues(browser.json, "running").find(
      (value) => typeof value === "boolean",
    );
    const browserPid = b8CollectKeyValues(browser.json, "pid").find(
      (value) => Number.isFinite(value),
    );
    const browserDriver = uniqStrings(b8CollectKeyValues(browser.json, "driver"))[0] ?? null;
    const browserProfile = uniqStrings(b8CollectKeyValues(browser.json, "profile"))[0] ?? null;

    const heapRssBefore = b8CollectKeyValues(heap.json, "rssBefore").find(Number.isFinite);
    const heapRssAfter = b8CollectKeyValues(heap.json, "rssAfter").find(Number.isFinite);
    const heapUsedBefore = b8CollectKeyValues(heap.json, "heapUsedBefore").find(Number.isFinite);
    const heapUsedAfter = b8CollectKeyValues(heap.json, "heapUsedAfter").find(Number.isFinite);
    const heapTruncated = b8CollectKeyValues(heap.json, "truncated").find(
      (value) => typeof value === "boolean",
    );
    const heapSummaryRows = Array.isArray(heap.json?.summary)
      ? heap.json.summary.slice(0, 8).map((row) => ({
          selfBytes: Number(row?.selfBytes || 0),
          totalBytes: Number(row?.totalBytes || 0),
          count: Number(row?.count || 0),
          topFrame:
            Array.isArray(row?.stack) && row.stack[0]
              ? {
                  functionName: String(row.stack[0]?.functionName || ""),
                  url: String(row.stack[0]?.url || ""),
                }
              : null,
        }))
      : [];

    const gatewayVersions = uniqStrings([
      ...b8CollectKeyValues(gatewayStatus.json, "version"),
      ...b8CollectKeyValues(gatewayStatus.json, "runtimeVersion"),
    ]);

    const result = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      modelTurnSubmitted: 0,
      probes: {
        stability: { code: stability.code, outputChars: stability.outputChars },
        browser: { code: browser.code, outputChars: browser.outputChars },
        memory: { code: memory.code, outputChars: memory.outputChars },
        gatewayStatus: { code: gatewayStatus.code, outputChars: gatewayStatus.outputChars },
        heapProfile: { code: heap.code, outputChars: heap.outputChars },
      },
      runtimeMemory: latestMemory
        ? {
            ...latestMemory,
            rssMinusHeapMinusExternalBytes: rssGapBytes,
          }
        : null,
      browser: {
        running: typeof browserRunning === "boolean" ? browserRunning : null,
        pid: Number.isFinite(browserPid) ? Number(browserPid) : null,
        driver: browserDriver,
        profile: browserProfile,
      },
      memorySearch: {
        providers: providerCandidates,
        models: modelCandidates,
        backends: backendCandidates,
      },
      heapProfile: {
        rssBefore: Number.isFinite(heapRssBefore) ? Number(heapRssBefore) : null,
        rssAfter: Number.isFinite(heapRssAfter) ? Number(heapRssAfter) : null,
        heapUsedBefore: Number.isFinite(heapUsedBefore) ? Number(heapUsedBefore) : null,
        heapUsedAfter: Number.isFinite(heapUsedAfter) ? Number(heapUsedAfter) : null,
        truncated: typeof heapTruncated === "boolean" ? heapTruncated : null,
        topSummary: heapSummaryRows,
      },
      gatewayVersions,
    };

    console.log("[b8-memory-v1] " + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      "[b8-memory-v1] failed=" +
        JSON.stringify({ errorClass: err?.constructor?.name || "Error" }),
    );
  }
}


function b8v2ReadText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function b8v2ParseProcStatus(pid) {
  const raw = b8v2ReadText(`/proc/${pid}/status`);
  if (!raw) return null;
  const fields = {};
  for (const line of raw.split(/\r?\n/u)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  const kb = (name) => {
    const match = String(fields[name] || "").match(/^(\d+)\s+kB$/u);
    return match ? Number(match[1]) * 1024 : null;
  };
  const integer = (name) => {
    const value = Number.parseInt(String(fields[name] || ""), 10);
    return Number.isFinite(value) ? value : null;
  };
  return {
    pid,
    ppid: integer("PPid"),
    name: String(fields.Name || "").slice(0, 80) || null,
    threads: integer("Threads"),
    vmRssBytes: kb("VmRSS"),
    rssAnonBytes: kb("RssAnon"),
    rssFileBytes: kb("RssFile"),
    rssShmemBytes: kb("RssShmem"),
    vmSizeBytes: kb("VmSize"),
    vmSwapBytes: kb("VmSwap"),
  };
}

function b8v2ParseSmapsRollup(pid) {
  const raw = b8v2ReadText(`/proc/${pid}/smaps_rollup`);
  if (!raw) return null;
  const wanted = new Set([
    "Rss",
    "Pss",
    "Pss_Anon",
    "Pss_File",
    "Pss_Shmem",
    "Shared_Clean",
    "Shared_Dirty",
    "Private_Clean",
    "Private_Dirty",
    "Anonymous",
    "AnonHugePages",
    "Swap",
  ]);
  const result = {};
  for (const line of raw.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/u);
    if (!match || !wanted.has(match[1])) continue;
    result[`${match[1]}Bytes`] = Number(match[2]) * 1024;
  }
  return Object.keys(result).length ? result : null;
}

function b8v2SafeExe(pid) {
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`)).slice(0, 80);
  } catch {
    return null;
  }
}

function b8v2ListProcesses() {
  let entries = [];
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const row = b8v2ParseProcStatus(Number(entry.name));
    if (row) rows.push(row);
  }
  return rows;
}

function b8v2Descendants(rootPid, rows) {
  const children = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.ppid)) continue;
    const list = children.get(row.ppid) || [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

function b8v2CaptureProcessTree() {
  const gatewayPid = gatewayProc?.pid;
  const rows = b8v2ListProcesses();
  const keep = new Set();
  for (const root of [process.pid, gatewayPid].filter(Number.isFinite)) {
    for (const pid of b8v2Descendants(root, rows)) keep.add(pid);
  }
  return {
    at: new Date().toISOString(),
    wrapperPid: process.pid,
    gatewayPid: Number.isFinite(gatewayPid) ? gatewayPid : null,
    processes: rows
      .filter((row) => keep.has(row.pid))
      .map((row) => ({
        ...row,
        exe: b8v2SafeExe(row.pid),
        smaps: b8v2ParseSmapsRollup(row.pid),
      }))
      .sort((a, b) => a.pid - b.pid),
  };
}

function b8v2FindKey(value, key, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = b8v2FindKey(item, key, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = b8v2FindKey(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function b8v2CompactWorkerPools(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [name, pool] of Object.entries(value)) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
    result[name] = Object.fromEntries(
      ["maxWorkers", "workers", "workersCreated", "activeTasks", "pendingTasks"]
        .map((key) => [key, Number.isFinite(pool[key]) ? Number(pool[key]) : null]),
    );
  }
  return Object.keys(result).length ? result : null;
}

async function b8v2GatewayProbe() {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const status = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["gateway", "status", "--deep", "--json", "--timeout", "10000"]),
    { env, timeoutMs: 25_000 },
  );
  const stability = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "gateway", "call", "diagnostics.stability",
      "--params", JSON.stringify({ limit: 200 }),
      "--timeout", "10000", "--json",
    ]),
    { env, timeoutMs: 20_000 },
  );
  const statusJson = status.code === 0 ? b8ParseJsonLoose(status.output) : null;
  const stabilityJson = stability.code === 0 ? b8ParseJsonLoose(stability.output) : null;
  const memoryRows = b8CollectMemoryRows(stabilityJson);
  return {
    statusCode: status.code,
    stabilityCode: stability.code,
    workerPools: b8v2CompactWorkerPools(b8v2FindKey(statusJson, "workerPools")),
    latestMemory: memoryRows.length ? memoryRows[memoryRows.length - 1] : null,
  };
}

async function runB8MemoryDiagnosticV2() {
  const markerPath = path.join(STATE_DIR, "b8-memory-diagnostic-v2.json");
  if (fs.existsSync(markerPath)) {
    console.log("[b8-memory-v2] skipped marker=present");
    return;
  }

  try {
    const first = b8v2CaptureProcessTree();
    const firstProbe = await b8v2GatewayProbe();
    await sleep(30_000);
    const second = b8v2CaptureProcessTree();
    await sleep(30_000);
    const third = b8v2CaptureProcessTree();
    const finalProbe = await b8v2GatewayProbe();

    const result = {
      version: 2,
      modelTurnSubmitted: 0,
      captureSeconds: [0, 30, 60],
      first,
      second,
      third,
      firstProbe,
      finalProbe,
    };
    console.log("[b8-memory-v2] " + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      "[b8-memory-v2] failed=" +
        JSON.stringify({ errorClass: err?.constructor?.name || "Error" }),
    );
  }
}


function c2PositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function c2ModelRefFromAgent(entry) {
  if (!entry || typeof entry !== "object") return null;
  const raw = typeof entry.model === "string" ? entry.model : entry.model?.primary;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function c2FindModelMetadata(value, targetRef, depth = 0, seen = new Set()) {
  if (depth > 12 || value == null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = c2FindModelMetadata(item, targetRef, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  const maxTokens = c2PositiveInt(value.maxTokens);
  if (maxTokens !== null) {
    const strings = [
      value.id,
      value.key,
      value.model,
      value.modelRef,
      value.ref,
      value.name,
      value.provider && value.id ? String(value.provider) + "/" + String(value.id) : null,
    ]
      .filter((v) => typeof v === "string")
      .map((v) => v.toLowerCase());
    const target = String(targetRef || "").toLowerCase();
    const targetTail = target.split("/").slice(-2).join("/");
    if (
      strings.some((v) => v === target || v.endsWith("/" + targetTail) || target.endsWith("/" + v))
    ) {
      return {
        maxTokens,
        contextWindow: c2PositiveInt(value.contextWindow),
        contextTokens: c2PositiveInt(value.contextTokens),
      };
    }
  }

  for (const child of Object.values(value)) {
    const found = c2FindModelMetadata(child, targetRef, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

async function runC2OutputEnvelopeDiagnosticV1() {
  const markerPath = path.join(STATE_DIR, "c2-output-envelope-diagnostic-v1.json");
  if (fs.existsSync(markerPath)) {
    console.log("[c2-envelope-v1] skipped marker=present");
    return;
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const tempRoot = path.join(os.tmpdir(), "c2-output-envelope-diagnostic-v1");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const configured = cfg?.agents?.entries ?? {};
    const stats = new Map();

    for (const [agentId, entry] of Object.entries(configured)) {
      const model = c2ModelRefFromAgent(entry);
      stats.set(agentId, {
        agentId,
        model,
        active: !(agentId === "counsel-03" && process.env.JARVIS_COUNSEL_03_ACTIVE?.trim() !== "1"),
        observedTurns: 0,
        largestOutputTokens: 0,
        largestAt: null,
        largestModel: null,
        currentEnvelope: c2PositiveInt(entry?.params?.maxTokens),
        exportFailures: 0,
      });
    }

    const listResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "sessions",
        "--all-agents",
        "--active",
        "10080",
        "--limit",
        "all",
        "--json",
      ]),
      { env, timeoutMs: 120_000 },
    );
    if (listResult.code !== 0) throw new Error("sessions list failed");
    const listed = b8ParseJsonLoose(listResult.output);
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];

    let exportedSessions = 0;
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const agentId = typeof session?.agentId === "string" ? session.agentId : null;
      const key = typeof session?.key === "string" ? session.key : null;
      if (!agentId || !key || !stats.has(agentId)) continue;

      const outputName = "session-" + index;
      const exportResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "sessions",
          "export-trajectory",
          "--session-key",
          key,
          "--agent",
          agentId,
          "--workspace",
          tempRoot,
          "--output",
          outputName,
          "--json",
        ]),
        { env, timeoutMs: 90_000 },
      );
      if (exportResult.code !== 0) {
        stats.get(agentId).exportFailures += 1;
        continue;
      }
      exportedSessions += 1;

      const branchPath = path.join(
        tempRoot,
        ".openclaw",
        "trajectory-exports",
        outputName,
        "session-branch.json",
      );
      if (!fs.existsSync(branchPath)) {
        stats.get(agentId).exportFailures += 1;
        continue;
      }
      let branch;
      try {
        branch = JSON.parse(fs.readFileSync(branchPath, "utf8"));
      } catch {
        stats.get(agentId).exportFailures += 1;
        continue;
      }

      for (const message of c1MessageRowsFromBranch(branch)) {
        if (message?.role !== "assistant") continue;
        const timestamp = Number(message.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < cutoffMs) continue;
        const outputTokens = c2PositiveInt(message?.usage?.output);
        if (outputTokens === null) continue;
        const row = stats.get(agentId);
        row.observedTurns += 1;
        if (outputTokens > row.largestOutputTokens) {
          row.largestOutputTokens = outputTokens;
          row.largestAt = new Date(timestamp).toISOString();
          row.largestModel =
            typeof message.model === "string"
              ? message.model
              : typeof session.model === "string"
                ? session.model
                : row.model;
        }
      }
    }

    for (const row of stats.values()) {
      if (!row.active || !row.model) continue;
      const modelsResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["models", "list", "--agent", row.agentId, "--json"]),
        { env, timeoutMs: 60_000 },
      );
      const modelsJson = modelsResult.code === 0 ? b8ParseJsonLoose(modelsResult.output) : null;
      const native = modelsJson ? c2FindModelMetadata(modelsJson, row.model) : null;
      row.nativeMaxTokens = native?.maxTokens ?? null;
      row.nativeContextWindow = native?.contextWindow ?? null;
      row.effectiveContextTokens = native?.contextTokens ?? native?.contextWindow ?? null;

      const formula = Math.max(32_000, row.largestOutputTokens * 2);
      row.formulaEnvelope = formula;
      row.candidateEnvelope =
        row.nativeMaxTokens && row.nativeMaxTokens > 0
          ? Math.min(formula, row.nativeMaxTokens)
          : formula;
      row.floorSatisfied = row.candidateEnvelope >= 32_000;
      row.doubleObservedSatisfied =
        row.largestOutputTokens === 0 || row.candidateEnvelope >= row.largestOutputTokens * 2;
      row.notContextMaximum =
        !row.effectiveContextTokens || row.candidateEnvelope !== row.effectiveContextTokens;
      row.readyToApply =
        row.floorSatisfied && row.doubleObservedSatisfied && row.notContextMaximum;
    }

    const result = {
      version: 1,
      generatedAt: new Date().toISOString(),
      windowDays: 7,
      cutoffAt: new Date(cutoffMs).toISOString(),
      normalizedOutputIncludesProviderReasoning: true,
      sessionsDiscovered: sessions.length,
      sessionsExported: exportedSessions,
      agents: Array.from(stats.values()),
    };
    console.log("[c2-envelope-v1] " + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      "[c2-envelope-v1] failed=" +
        JSON.stringify({ errorClass: err?.constructor?.name || "Error", message: String(err?.message || err).slice(0, 300) }),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}


function c2UsageSnapshot(message) {
  const usage = message?.usage && typeof message.usage === "object" ? message.usage : {};
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    model: typeof message?.model === "string" ? message.model : null,
    provider: typeof message?.provider === "string" ? message.provider : null,
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    totalTokens: num(usage.totalTokens),
    costTotal: num(usage?.cost?.total),
  };
}


async function runC2CacheInspectV1() {
  const markerPath = path.join(STATE_DIR, "c2-cache-inspect-v1.json");
  if (fs.existsSync(markerPath)) {
    console.log("[c2-cache-inspect-v1] skipped marker=present");
    return;
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const sessionKey = "agent:main:explicit:c2-cache-proof-v2";
  const tempRoot = path.join(os.tmpdir(), "c2-cache-inspect-v1");
  const outputName = "inspect";
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const exported = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "sessions", "export-trajectory",
        "--session-key", sessionKey,
        "--agent", "main",
        "--workspace", tempRoot,
        "--output", outputName,
        "--json",
      ]),
      { env, timeoutMs: 120_000 },
    );
    if (exported.code !== 0) throw new Error("trajectory export failed");

    const branchPath = path.join(
      tempRoot,
      ".openclaw",
      "trajectory-exports",
      outputName,
      "session-branch.json",
    );
    const branch = JSON.parse(fs.readFileSync(branchPath, "utf8"));
    const rows = c1MessageRowsFromBranch(branch).map((message, index) => {
      const meta =
        message?.__openclaw && typeof message.__openclaw === "object"
          ? message.__openclaw
          : {};
      const usage = c2UsageSnapshot(message);
      return {
        index,
        role: typeof message?.role === "string" ? message.role : null,
        idempotencyKey:
          typeof message?.idempotencyKey === "string"
            ? message.idempotencyKey
            : typeof meta?.idempotencyKey === "string"
              ? meta.idempotencyKey
              : null,
        provider: usage.provider,
        model: usage.model,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        costTotal: usage.costTotal,
        stopReason: typeof message?.stopReason === "string" ? message.stopReason : null,
      };
    });
    const result = {
      version: 1,
      generatedAt: new Date().toISOString(),
      sessionKey,
      modelTurns: rows.filter(
        (row) =>
          row.role === "assistant" &&
          !(row.provider === "openclaw" && ["gateway-injected", "delivery-mirror"].includes(row.model)),
      ),
      allRows: rows,
    };
    console.log("[c2-cache-inspect-v1] " + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      "[c2-cache-inspect-v1] failed=" +
        JSON.stringify({
          errorClass: err?.constructor?.name || "Error",
          message: String(err?.message || err).slice(0, 300),
        }),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runC2CacheProofV2() {
  const markerPath = path.join(STATE_DIR, "c2-cache-proof-v2.json");
  if (fs.existsSync(markerPath)) {
    console.log("[c2-cache-v2] skipped marker=present");
    return;
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const sessionKey = "agent:main:explicit:c2-cache-proof-v2";
  const turns = [
    { runId: "c2-cache-v2-turn-1", message: "Reply exactly C2-CACHE-ONE. Do not use tools." },
    { runId: "c2-cache-v2-turn-2", message: "Reply exactly C2-CACHE-TWO. Do not use tools." },
  ];
  const results = [];

  try {
    for (const turn of turns) {
      const send = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "gateway",
          "call",
          "chat.send",
          "--params",
          JSON.stringify({
            sessionKey,
            agentId: "main",
            message: turn.message,
            thinking: "off",
            deliver: false,
            idempotencyKey: turn.runId,
          }),
          "--expect-final",
          "--timeout",
          "120000",
          "--json",
        ]),
        { env, timeoutMs: 140_000 },
      );
      if (send.code !== 0) throw new Error("cache proof chat.send failed");

      const history = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "gateway",
          "call",
          "chat.history",
          "--params",
          JSON.stringify({
            sessionKey,
            agentId: "main",
            limit: 20,
            maxChars: 131072,
          }),
          "--timeout",
          "15000",
          "--json",
        ]),
        { env, timeoutMs: 25_000 },
      );
      if (history.code !== 0) throw new Error("cache proof chat.history failed");

      const payload = b8ParseJsonLoose(history.output);
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const assistant = messages
        .slice()
        .reverse()
        .find((message) => {
          if (!message || message.role !== "assistant") return false;
          const meta = message.__openclaw && typeof message.__openclaw === "object"
            ? message.__openclaw
            : {};
          return message.idempotencyKey === turn.runId || meta.idempotencyKey === turn.runId;
        }) ?? messages.slice().reverse().find((message) => message?.role === "assistant");

      if (!assistant) throw new Error("cache proof assistant message missing");
      results.push({
        runId: turn.runId,
        ...c2UsageSnapshot(assistant),
      });
    }

    const result = {
      version: 2,
      generatedAt: new Date().toISOString(),
      sessionKey,
      deliveredExternally: false,
      thinking: "off",
      turns: results,
      cacheTelemetryVisible: results.every((row) => Number.isFinite(row.cacheRead)),
      secondTurnCacheHit: (results[1]?.cacheRead ?? 0) > 0,
      pass:
        results.length === 2 &&
        results.every((row) => Number.isFinite(row.cacheRead)) &&
        (results[1]?.cacheRead ?? 0) > 0,
    };
    console.log("[c2-cache-v2] " + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    const result = {
      version: 2,
      generatedAt: new Date().toISOString(),
      sessionKey,
      pass: false,
      errorClass: err?.constructor?.name || "Error",
      message: String(err?.message || err).slice(0, 300),
      turns: results,
    };
    console.error("[c2-cache-v2] failed=" + JSON.stringify(result));
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

async function runC1FreshFloorV1() {
  const sessionKey = "agent:main:main";
  const markerPath = path.join(STATE_DIR, "c1-fresh-floor-v1.json");
  const measuredMarkerPath = path.join(STATE_DIR, "c1-fresh-floor-v1.measured.json");
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || String(process.pid);
  const baseRunId = "c1-fresh-floor-" + deploymentId;
  const gatewayEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };
  const writeMarker = (state, extra = {}) => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ state, deploymentId, at: new Date().toISOString(), ...extra }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  };

  if (fs.existsSync(markerPath)) {
    let state = "present";
    try {
      state = JSON.parse(fs.readFileSync(markerPath, "utf8"))?.state || state;
    } catch {}

    if (state === "completed" && !fs.existsSync(measuredMarkerPath)) {
      console.log("[c1-fresh-floor-v1] pending-measure");
      const measured = await runC1ContextDiagnosticV1("fresh-floor");
      if (!measured) {
        console.error("[c1-fresh-floor-v1] measurement=failed");
        return false;
      }
      fs.writeFileSync(
        measuredMarkerPath,
        JSON.stringify(
          {
            state: "measured",
            deploymentId,
            at: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      console.log("[c1-fresh-floor-v1] measurement=completed");
      return true;
    }

    console.log(
      "[c1-fresh-floor-v1] skipped marker=" +
        state +
        " measured=" +
        (fs.existsSync(measuredMarkerPath) ? "yes" : "no"),
    );
    return true;
  }

  let stage = "marker";
  writeMarker("started", { stage });

  try {
    stage = "reset";
    const resetResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "gateway",
        "call",
        "sessions.reset",
        "--params",
        JSON.stringify({ key: sessionKey, agentId: "main", reason: "reset" }),
        "--timeout",
        "30000",
        "--json",
      ]),
      { env: gatewayEnv, timeoutMs: 45_000 },
    );
    if (resetResult.code !== 0) throw new Error("session reset failed");
    console.log("[c1-fresh-floor-v1] reset=ok");

    stage = "one-line-turn";
    const turnResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "gateway",
        "call",
        "chat.send",
        "--params",
        JSON.stringify({
          sessionKey,
          agentId: "main",
          message: "Reply only with OK.",
          deliver: false,
          idempotencyKey: baseRunId + "-turn",
        }),
        "--expect-final",
        "--timeout",
        "60000",
        "--json",
      ]),
      { env: gatewayEnv, timeoutMs: 75_000 },
    );
    if (turnResult.code !== 0) throw new Error("one-line turn failed");
    console.log("[c1-fresh-floor-v1] one-line-turn=ok");

    writeMarker("completed", { stage: "awaiting-measure" });
    console.log("[c1-fresh-floor-v1] completed measurement=deferred");
    return false;
  } catch (err) {
    writeMarker("failed", {
      stage,
      errorClass: err?.constructor?.name || "Error",
    });
    console.error(
      "[c1-fresh-floor-v1] failed=" +
        JSON.stringify({ stage, errorClass: err?.constructor?.name || "Error" }),
    );
    return false;
  }
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (!safeEqual(password, SETUP_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function requireSameOriginForAdminWrite(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  // Modern browsers identify cross-site form/fetch requests even when an Origin
  // header is omitted by a legacy path. Non-browser API clients typically send
  // neither header and remain supported.
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return res.status(403).json({ ok: false, error: "Cross-site admin request rejected" });
  }

  const origin = String(req.headers.origin || "").trim();
  if (!origin) return next();

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  const host = String(req.headers.host || "").trim();
  if (!host || origin !== `${proto}://${host}`) {
    return res.status(403).json({ ok: false, error: "Admin request origin mismatch" });
  }
  return next();
}

// Setup/admin responses may contain sensitive operational data; never let browsers or proxies cache them.
app.use("/setup", requireSameOriginForAdminWrite, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Deliberately expose only coarse health state; no paths, ports, errors, or config metadata.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({ ok: true, gatewayReachable });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

async function ensureJarvisLobsterV1() {
  if (!isConfigured()) return { ok: false, reason: "not-configured" };

  const workflowDir = path.join(WORKSPACE_DIR, "workflows");
  const workflowPath = path.join(workflowDir, "jarvis-health-v1.lobster");
  const duplicateExternalPath = path.join(STATE_DIR, "extensions", "lobster");

  try {
    // OpenClaw v2026.9.5 already ships Lobster as a bundled extension.
    // Remove the accidental external duplicate created by the earlier install
    // attempt so the bundled, version-matched plugin remains authoritative.
    if (fs.existsSync(duplicateExternalPath)) {
      fs.rmSync(duplicateExternalPath, { recursive: true, force: true });
      console.log("[lobster-v1] removed duplicate external extension; using bundled Lobster");
    }

    fs.mkdirSync(workflowDir, { recursive: true, mode: 0o700 });
    const workflow = [
      "name: jarvis-health-v1",
      "steps:",
      "  - id: status",
      "    command: openclaw status --json",
      "  - id: plugins",
      "    command: openclaw plugins list --json",
      "",
    ].join("\n");
    fs.writeFileSync(workflowPath, workflow, { encoding: "utf8", mode: 0o600 });
    console.log("[lobster-v1] bundled plugin selected; read-only health workflow installed");
    return { ok: true, mode: "bundled", workflowPath };
  } catch (err) {
    console.warn("[lobster-v1] setup failed (continuing): " + String(err));
    return { ok: false, reason: "exception" };
  }
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Railway runs behind a reverse proxy. Trust loopback as a proxy hop so local client detection
    // remains correct when X-Forwarded-* headers are present.
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"]) ]),
    );

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

        // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
        const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${plug.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${fix.output || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  return respondJson(ok ? 200 : 500, {
    ok,
    output: redactSecrets(`${prefix}${onboard.output}${extra}`),
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
      try { fs.chmodSync(backupPath, 0o600); } catch {}
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const channelId = String(channel).trim();
  const pairingCode = String(code).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelId) || !/^[A-Za-z0-9_-]{4,128}$/.test(pairingCode)) {
    return res.status(400).json({ ok: false, error: "Invalid pairing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", channelId, pairingCode]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

function requireExportAuth(req, res, next) {
  // Preferred path for automation: a dedicated bearer token with backup-only scope.
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (
    scheme === "Bearer" &&
    encoded &&
    BACKUP_EXPORT_TOKEN &&
    safeEqual(encoded, BACKUP_EXPORT_TOKEN)
  ) {
    return next();
  }

  // Preserve existing human recovery access via SETUP_PASSWORD.
  return requireSetupAuth(req, res, next);
}

async function createFullDataArchive(dataRoot, archivePath) {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      "tar",
      [
        "--create",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        dataRoot,
        "--warning=no-file-changed",
        ".",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderrBytes = 0;
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code: Number.isInteger(code) ? code : 2,
        signal: signal || null,
        stderrBytes,
      });
    });
  });
}

app.get("/setup/export", requireExportAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Export the entire Railway persistent volume. A recovery archive must cover
  // every /data area, not only OpenClaw state/workspace.
  const dataRoot = "/data";
  if (!fs.existsSync(dataRoot)) {
    return res.status(500).type("text/plain").send("/data volume is not mounted\n");
  }

  const topLevel = fs.readdirSync(dataRoot).sort();
  if (topLevel.length === 0) {
    return res.status(500).type("text/plain").send("/data volume is empty\n");
  }
  console.log("[export] full /data backup top-level=" + JSON.stringify(topLevel));

  // GNU tar uses exit 1 for recoverable file-change conditions and exit 2 for
  // fatal errors. Build to /tmp first so a failed attempt never sends a partial
  // HTTP archive. Retry exit 1 once; any exit 2 (or a second exit 1) fails.
  const archivePath = path.join(
    os.tmpdir(),
    `openclaw-export-${process.pid}-${Date.now()}.tar.gz`,
  );
  const cleanup = () => {
    try { fs.rmSync(archivePath, { force: true }); } catch {}
  };

  try {
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      cleanup();
      result = await createFullDataArchive(dataRoot, archivePath);
      console.log(
        `[export] tar attempt=${attempt} exit=${result.code} stderrBytes=${result.stderrBytes}`,
      );

      if (result.code === 0) break;
      if (result.code === 1 && attempt === 1) {
        console.warn("[export] tar exit 1; retrying full archive once");
        await sleep(250);
        continue;
      }

      if (result.code === 2) {
        throw new Error("tar failed with fatal exit 2");
      }
      if (result.code === 1) {
        throw new Error("tar exit 1 persisted after retry");
      }
      throw new Error(
        `tar failed with unexpected exit ${result.code}${result.signal ? ` signal=${result.signal}` : ""}`,
      );
    }

    const stat = fs.statSync(archivePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("tar produced an empty archive");
    }

    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-length", String(stat.size));
    res.setHeader(
      "content-disposition",
      `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
    );

    const stream = fs.createReadStream(archivePath);
    stream.on("error", (err) => {
      console.error("[export] archive read failed", err);
      cleanup();
      if (!res.headersSent) res.status(500);
      res.end("Backup archive read failed\n");
    });
    res.once("finish", cleanup);
    res.once("close", cleanup);
    stream.pipe(res);
  } catch (err) {
    cleanup();
    console.error("[export] backup failed: " + String(err));
    if (!res.headersSent) {
      return res.status(500).type("text/plain").send("Backup export failed\n");
    }
    res.end();
  }
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p, entry) => {
        // Allow only safe relative paths. Restore archives do not need links;
        // rejecting symlink/hardlink entries prevents link-based escape tricks.
        if (!looksSafeTarPath(p)) return false;
        const type = String(entry?.type || "");
        if (type === "SymbolicLink" || type === "Link") return false;
        return true;
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

// --- Dashboard password protection ---
// Require the same SETUP_PASSWORD for the entire Control UI dashboard,
// not just the /setup routes.  Healthcheck is excluded so Railway probes work.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Cookie-based dashboard session: value = HMAC(SETUP_PASSWORD) so verification
// is stateless, invalidates on password change, and never echoes the password.
const DASHBOARD_COOKIE = "oc_dashboard_session";
function dashboardSessionToken() {
  if (!SETUP_PASSWORD) return "";
  return crypto.createHmac("sha256", SETUP_PASSWORD).update("oc_dashboard_v1").digest("hex");
}
function hasValidDashboardCookie(req) {
  if (!SETUP_PASSWORD) return false;
  const expected = dashboardSessionToken();
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === DASHBOARD_COOKIE && v && safeEqual(v, expected)) return true;
  }
  return false;
}

function wantsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function renderLoginPage(message) {
  const msg = message ? `<p class="err">${escapeHtml(message)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0d10; color:#e6e8eb; }
  form { background:#13171c; padding:28px 32px; border-radius:12px;
         box-shadow:0 10px 40px rgba(0,0,0,.4); min-width:320px; }
  h1 { margin:0 0 16px; font-size:18px; font-weight:600; letter-spacing:.2px; }
  label { display:block; margin:14px 0 6px; font-size:13px; color:#9aa4ae; }
  input[type=password] { width:100%; padding:10px 12px; border-radius:8px;
         border:1px solid #23272d; background:#0b0d10; color:inherit; font-size:14px; }
  button { margin-top:18px; width:100%; padding:10px 12px; border-radius:8px;
         border:0; background:#3d6bff; color:#fff; font-weight:600; cursor:pointer; }
  button:hover { background:#4a76ff; }
  .err { margin:0 0 10px; color:#ff6b6b; font-size:13px; }
</style>
</head>
<body>
<form method="POST" action="/__login" autocomplete="off">
  <h1>OpenClaw Dashboard</h1>
  ${msg}
  <label for="p">Password</label>
  <input id="p" type="password" name="password" autofocus required>
  <button type="submit">Unlock</button>
</form>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setDashboardCookie(res) {
  const token = dashboardSessionToken();
  res.append(
    "Set-Cookie",
    `${DASHBOARD_COOKIE}=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
  );
}

// POST /__login — exchange SETUP_PASSWORD for a session cookie; browsers land
// here from renderLoginPage. Keeps the native Basic prompt out of the UX.
app.post(
  "/__login",
  express.urlencoded({ extended: false, limit: "16kb" }),
  (req, res) => {
    if (!SETUP_PASSWORD) return res.redirect("/");
    const submitted = String(req.body?.password ?? "");
    if (!safeEqual(submitted, SETUP_PASSWORD)) {
      return res.status(401).type("html").send(renderLoginPage("Incorrect password."));
    }
    setDashboardCookie(res);
    const nextPath = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : "/";
    return res.redirect(nextPath);
  },
);

function requireDashboardAuth(req, res, next) {
  // Browsers often request /favicon.ico before the dashboard session exists.
  // Returning 204 prevents that background request from triggering a native Basic-auth popup.
  if (req.path === "/favicon.ico") return res.status(204).end();
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth
  if (req.path === "/__login") return next();
  if (!SETUP_PASSWORD) return next(); // no password configured → open

  // Cookie session: already authenticated via /__login form.
  if (hasValidDashboardCookie(req)) return next();

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  // Accept `Authorization: Bearer <GATEWAY_TOKEN>` as an equivalent credential so
  // API clients / CLIs that already hold the gateway token aren't forced through
  // a login UI. The Bearer header passes through to the gateway unchanged.
  if (scheme === "Bearer" && encoded && OPENCLAW_GATEWAY_TOKEN && safeEqual(encoded, OPENCLAW_GATEWAY_TOKEN)) {
    return next();
  }

  // Accept Basic for non-browser clients (curl, scripts) that already integrated
  // against the old behavior. On success, also set the cookie so repeat browser
  // requests don't need to resend credentials.
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (safeEqual(password, SETUP_PASSWORD)) {
      setDashboardCookie(res);
      return next();
    }
  }

  // Browsers: render an HTML login form instead of the native Basic dialog.
  if (wantsHtml(req) && req.method === "GET") {
    return res.status(401).type("html").send(renderLoginPage());
  }
  // Non-browser clients still get a Basic/Bearer challenge.
  res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard", Bearer realm="OpenClaw Gateway"');
  return res.status(401).send("Auth required");
}

// --- Gateway token injection ---
// The gateway is only reachable from this container. The Control UI in the browser
// cannot set custom Authorization headers for WebSocket connections, so we inject
// the token into proxied requests at the wrapper level.
//
// Must overwrite any existing Authorization header: once dashboard auth has been
// validated, the browser's `Basic <SETUP_PASSWORD>` header would otherwise leak to
// the gateway and be rejected as a token mismatch.
function attachGatewayAuthHeader(req) {
  if (!req?.headers || !OPENCLAW_GATEWAY_TOKEN) return;
  req.headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
}

proxy.on("proxyReqWs", (_proxyReq, req) => {
  attachGatewayAuthHeader(req);
});

// --- Control UI bootstrap ---
// openclaw >= v2026.4.24 changed the Control UI so the gateway token is read from
// localStorage["openclaw.control.settings.v1"].token and sent inside the WS
// handshake message payload, not as an HTTP Authorization header. The wrapper's
// proxy-level Authorization injection is therefore invisible to the new auth
// path, and the gateway replies with reason=token_missing — surfacing as a
// second Basic auth prompt / "paste token in Control UI settings" error.
//
// Before the Control UI loads for the first time in a browser, serve a small
// bootstrap HTML that writes the known gateway token into localStorage. Gated by
// a cookie so it only runs once, and only served after requireDashboardAuth so
// the token never leaves the authenticated dashboard trust boundary.
const BOOTSTRAP_COOKIE = "oc_wrapper_bootstrapped";
const CONTROL_UI_SETTINGS_KEY = "openclaw.control.settings.v1";

function needsControlUiBootstrap(req) {
  if (!OPENCLAW_GATEWAY_TOKEN) return false;
  if (req.method !== "GET") return false;
  if (req.path !== "/") return false;
  const accept = String(req.headers.accept || "");
  if (!accept.includes("text/html")) return false;
  const cookie = String(req.headers.cookie || "");
  return !cookie.split(";").some((c) => c.trim().startsWith(`${BOOTSTRAP_COOKIE}=`));
}

function sendControlUiBootstrap(res) {
  const tokenJson = JSON.stringify(OPENCLAW_GATEWAY_TOKEN);
  const keyJson = JSON.stringify(CONTROL_UI_SETTINGS_KEY);
  // Token lands in client-side localStorage; this response is only reachable after
  // requireDashboardAuth has validated SETUP_PASSWORD.
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Loading Control UI…</title></head>
<body>
<script>
(function () {
  try {
    var key = ${keyJson};
    var current = {};
    try { current = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (_) {}
    if (!current.token) current.token = ${tokenJson};
    localStorage.setItem(key, JSON.stringify(current));
  } catch (_) {}
  document.cookie = "${BOOTSTRAP_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Strict; Secure";
  location.replace("/");
})();
</script>
</body>
</html>
`;
  res.set("Cache-Control", "no-store");
  res.status(200).type("html").send(html);
}

app.use(requireDashboardAuth, async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured() && needsControlUiBootstrap(req)) {
    return sendControlUiBootstrap(res);
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});


function applyJarvisOperationalDefaults() {
  if (!isConfigured()) return;
  const p = configPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const cfg = JSON.parse(raw);

    cfg.tools ??= {};
    // Remove stale legacy explicit allowlists. They override profile resolution and
    // can make leaf adviser agents fail before the model is called.
    delete cfg.tools.allow;
    cfg.tools.profile = "coding";
    cfg.tools.loopDetection ??= {};
    // v2026.9.5 accepts only the master switch here; its retired tuning knobs
    // are intentionally omitted so OpenClaw's built-in detector defaults apply.
    cfg.tools.loopDetection.enabled = true;
    console.log("[loop-detection-v1] enabled=true retired-runtime-tuning=absent");
    if (cfg.tools.codeMode === undefined) cfg.tools.codeMode = "auto";
    // v2026.3.8 merges global tools.alsoAllow into every agent profile.
    // That turns the intentionally-empty "minimal" adviser profile into a
    // restrictive explicit allowlist and aborts adviser runs before inference.
    // Keep these additive capabilities on Jarvis/main only.
    delete cfg.tools.alsoAllow;
    const mainEntry = cfg.agents?.entries?.main;
    if (mainEntry) {
      mainEntry.tools ??= {};
      mainEntry.tools.profile = mainEntry.tools.profile ?? "coding";
      delete mainEntry.tools.allow;
      mainEntry.tools.alsoAllow = Array.from(new Set([
        ...(Array.isArray(mainEntry.tools.alsoAllow) ? mainEntry.tools.alsoAllow : []),
        "group:messaging",
        "browser",
        "gateway",
        "lobster",
      ]));
    }

    // Researchers are evidence-only leaves. "full" contributes no profile-level
    // allowlist, so their existing explicit browser/web allowlist stays authoritative
    // instead of being intersected with the global coding profile.
    for (const id of ["research-01", "research-02"]) {
      const entry = cfg.agents?.entries?.[id];
      if (!entry) continue;
      entry.tools ??= {};
      entry.tools.profile = "full";
      delete entry.tools.alsoAllow;
    }

    // Non-revenue-token controls: keep frontier intelligence, cap pathological
    // completion envelopes, and make adviser seats pure reasoning leaves.
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.models ??= {};
    cfg.agents.defaults.subagents ??= {};
    cfg.agents.defaults.subagents.maxConcurrent = 4;
    cfg.agents.defaults.subagents.maxSpawnDepth = 1;

    // Permanent-team memory consolidation. One managed Memory Core sweep covers
    // the primary Jarvis workspace plus configured adviser workspaces without
    // mixing one adviser's private transcript corpus into another's.
    cfg.plugins ??= {};
    cfg.plugins.entries ??= {};
    cfg.plugins.entries["memory-core"] ??= {};
    cfg.plugins.entries["memory-core"].config ??= {};
    cfg.plugins.entries["memory-core"].config.dreaming ??= {};
    cfg.plugins.entries["memory-core"].config.dreaming.enabled = true;
    cfg.plugins.entries["memory-core"].config.dreaming.timezone = "Asia/Qatar";
    cfg.plugins.entries["memory-core"].config.dreaming.frequency = "0 3 * * *";
    cfg.plugins.entries["lobster"] ??= {};
    cfg.plugins.entries["lobster"].enabled = true;

    // The runtime already bundles Lobster. Remove install metadata/load paths
    // from the accidental external duplicate so the bundled plugin is authoritative.
    if (cfg.plugins.installs && typeof cfg.plugins.installs === "object") {
      delete cfg.plugins.installs.lobster;
      if (Object.keys(cfg.plugins.installs).length === 0) delete cfg.plugins.installs;
    }
    if (cfg.plugins.load?.paths && Array.isArray(cfg.plugins.load.paths)) {
      const duplicatePath = path.join(STATE_DIR, "extensions", "lobster");
      cfg.plugins.load.paths = cfg.plugins.load.paths.filter((p) => String(p) !== duplicatePath);
      if (cfg.plugins.load.paths.length === 0) delete cfg.plugins.load.paths;
      if (cfg.plugins.load && Object.keys(cfg.plugins.load).length === 0) delete cfg.plugins.load;
    }

    // Main Jarvis latency: Grok 4.7 is tool-capable but is not currently
    // catalog-marked as a preferred Code Mode model, so global "auto" leaves
    // the full coding/browser/gateway/messaging tool schemas in every provider
    // request. Force generic Code Mode for this exact model only. This preserves
    // the authorized tool catalog while deferring full schemas until actually
    // needed, materially reducing ordinary WhatsApp prompt prefill.
    cfg.agents.defaults.models["openrouter/x-ai/grok-4.7"] ??= {};
    cfg.agents.defaults.models["openrouter/x-ai/grok-4.7"].codeMode = true;

    // Capability policy: do not impose Jarvis-specific output-token ceilings.
    // Let each provider/model use its native output/reasoning capacity. Financial
    // control lives at OpenRouter/prepaid credit; structural safeguards below
    // still bound recursion, concurrency, and tool loops.
    for (const modelRef of [
      "openrouter/openai/gpt-5.6-sol",
      "openrouter/anthropic/claude-fable-5.1",
      "openrouter/anthropic/claude-sonnet-5",
      "openrouter/x-ai/grok-4.7",
      "openrouter/google/gemini-3.8-flash",
    ]) {
      const modelCfg = cfg.agents.defaults.models[modelRef];
      if (!modelCfg || typeof modelCfg !== "object" || Array.isArray(modelCfg)) continue;
      if (modelCfg.params && typeof modelCfg.params === "object") {
        delete modelCfg.params.maxTokens;
        if (Object.keys(modelCfg.params).length === 0) delete modelCfg.params;
      }
    }

    // Forum/Counsel advisers are reasoning leaves, but Telegram-bound seats
    // must be able to publish their own messages/artifacts under the seat identity.
    // Use the minimal profile, keep its outbound message capability, and deny
    // status/orchestration/research/operator tools.
    const adviserIds = [
      "forum-01", "forum-02", "forum-03",
      "counsel-01", "counsel-02", "counsel-03",
    ];
    for (const id of adviserIds) {
      const entry = cfg.agents.entries?.[id];
      if (!entry) continue;
      entry.tools ??= {};
      entry.tools.profile = "minimal";
      delete entry.tools.allow;
      entry.tools.deny = Array.from(new Set([
        ...(Array.isArray(entry.tools.deny) ? entry.tools.deny : []),
        "session_status", "gateway",
        "sessions_send", "sessions_spawn", "sessions_list",
        "sessions_history", "sessions_search", "sessions_yield", "subagents",
        "browser", "web_search", "web_fetch", "skill_workshop",
        "exec", "process", "read", "write", "edit", "apply_patch",
      ]));
    }

    // Reconcile per-seat private memory, shared Jarvis backbone indexing, Active
    // Memory recall, and the ambient system owner used by the team-wide dream sweep.
    applyJarvisAdviserMemoryV1({ cfg, mainWorkspaceDir: WORKSPACE_DIR });

    // Research system v1.1: dedicated stateless Verifier/Scout plus persistent evidence scaffold.
    applyJarvisResearchSystemV1({ cfg, mainWorkspaceDir: WORKSPACE_DIR });

    // Canonical user-selected model occupants/effort levels; Counsel 3 remains dormant until filled.
    applyJarvisSeatConfigV1({ cfg });

    // One-line, non-secret policy diagnostic for the v2026.3.8 tool resolver.
    // Safe to keep: it reports only profile/allow/alsoAllow/deny names.
    try {
      const ids = ["main", "research-01", "research-02", ...adviserIds];
      const entries = Object.fromEntries(ids.map((id) => {
        const t = cfg.agents.entries?.[id]?.tools ?? {};
        return [id, {
          profile: t.profile ?? null,
          allow: Array.isArray(t.allow) ? t.allow : null,
          alsoAllow: Array.isArray(t.alsoAllow) ? t.alsoAllow : null,
          deny: Array.isArray(t.deny) ? t.deny : null,
        }];
      }));
      console.log("[tool-policy-diag-v1] " + JSON.stringify({
        global: {
          profile: cfg.tools.profile ?? null,
          allow: Array.isArray(cfg.tools.allow) ? cfg.tools.allow : null,
          alsoAllow: Array.isArray(cfg.tools.alsoAllow) ? cfg.tools.alsoAllow : null,
          deny: Array.isArray(cfg.tools.deny) ? cfg.tools.deny : null,
        },
        entries,
      }));
    } catch {}

    // Dedicated Jarvis WhatsApp front door: keep first-run access conservative.
    // Unknown DMs must pair. Groups remain disabled unless the explicit
    // Jarvis WhatsApp Rooms feature is enabled.
    cfg.channels ??= {};
    cfg.channels.whatsapp ??= {};
    cfg.channels.whatsapp.enabled = true;
    cfg.channels.whatsapp.dmPolicy = "pairing";

    // WhatsApp has no editable preview transport. Stream completed assistant
    // text blocks as normal WhatsApp messages so the owner sees useful text
    // while long/high-reasoning completions continue instead of waiting for
    // the entire final response.
    cfg.channels.whatsapp.streaming ??= {};
    cfg.channels.whatsapp.streaming.chunkMode = "newline";
    cfg.channels.whatsapp.streaming.block ??= {};
    cfg.channels.whatsapp.streaming.block.enabled = true;
    cfg.channels.whatsapp.streaming.block.coalesce = {
      minChars: 40,
      maxChars: 700,
      idleMs: 150,
    };
    cfg.agents.defaults.blockStreamingBreak = "text_end";
    cfg.agents.defaults.blockStreamingChunk = {
      minChars: 40,
      maxChars: 700,
      breakPreference: "sentence",
    };
    cfg.agents.defaults.humanDelay = { mode: "off" };

    if (process.env.JARVIS_WHATSAPP_ROOMS_V1?.trim() !== "1") {
      cfg.channels.whatsapp.groupPolicy = "disabled";
    }
    cfg.browser ??= {};
    cfg.browser.enabled = true;
    cfg.browser.executablePath = "/usr/bin/chromium";
    cfg.browser.headless = true;
    cfg.browser.noSandbox = true;
    cfg.browser.defaultProfile ??= "openclaw";

    // Autonomous Skill Workshop reviews are model calls. Keep learning available
    // only when explicitly requested; do not spend tokens after ordinary turns.
    cfg.skills ??= {};
    cfg.skills.workshop ??= {};
    cfg.skills.workshop.autonomous ??= {};
    cfg.skills.workshop.autonomous.mode = "off";

    // Install a local high-priority recovery skill once. OpenClaw watches workspace
    // skills, so future human edits are preserved and picked up automatically.
    const stucklessDir = path.join(WORKSPACE_DIR, "skills", "stuckless");
    const stucklessPath = path.join(stucklessDir, "SKILL.md");
    if (!fs.existsSync(stucklessPath)) {
      fs.mkdirSync(stucklessDir, { recursive: true });
      const stucklessSkill = [
        "---",
        "name: stuckless",
        "description: Bounded recovery protocol for repeated tool, browser, web, model, and multi-step task failures.",
        "user-invocable: false",
        "---",
        "",
        "# Stuckless recovery protocol",
        "",
        "Use this whenever a tool, browser action, web source, model call, or multi-step task fails, stalls, or repeats.",
        "",
        "1. Never repeat the same failing tool call with identical arguments more than twice.",
        "2. After two equivalent failures, change the method rather than merely retrying.",
        "3. Keep a hard budget of four attempts for one failure family. If no progress after four, stop the loop and report the blocker.",
        "4. For research: prefer search/RSS or web fetch first; use browser automation when interaction or rendered content is required. If a source returns 401/403/JS blocking, switch to another reputable source instead of hammering it.",
        "5. For browser trouble: inspect browser status and tabs, reuse a stable tab when possible, resnapshot after page changes, then try one clean tab. Captcha, MFA, login approval, camera, or microphone blockers require the owner.",
        "6. For command/tool errors: read the exact error and inspect current state before changing anything. Change one relevant variable at a time and verify the result.",
        "7. Before any gateway restart or action that may interrupt the current turn, write /data/workspace/recovery/active-task.md with the user goal, completed work, last error, and next action. Restart the gateway at most once for the same failure, then resume from the checkpoint.",
        "8. Do not autonomously restart or redeploy the Railway service, delete/reset persistent state, delete databases or volumes, rotate secrets, or rewrite provider credentials. Those are supervisor/operator actions.",
        "9. Do not claim a source or action succeeded if it failed. For multi-source research, distinguish successful sources from attempted/blocked sources.",
        "10. When a non-obvious recovery reliably works and is reusable, send it through Skill Workshop as a proposed improvement. Do not create a recursive self-edit loop.",
        "",
        "Recovery priority: continue safely -> switch tool/path -> isolate the failing component -> checkpoint -> one bounded gateway restart if appropriate -> escalate.",
        ""
      ].join("\n");
      fs.writeFileSync(stucklessPath, stucklessSkill, { encoding: "utf8", mode: 0o600 });
      console.log("[wrapper] installed stuckless recovery skill");
    }

    // Durable orchestration economics for the main Jarvis brain. Stable room
    // seats are addressed as sessions, not spawned as background children, which
    // avoids extra completion-announcement model turns for normal room traffic.
    const agentsPolicyPath = path.join(WORKSPACE_DIR, "AGENTS.md");
    const nrtMarker = "## Jarvis Non-Revenue Token Policy v1";
    if (fs.existsSync(agentsPolicyPath)) {
      let agentsText = fs.readFileSync(agentsPolicyPath, "utf8");
      if (!agentsText.includes(nrtMarker)) {
        const nrtPolicy = [
          nrtMarker,
          "",
          "- Treat model calls like metered utility flow: every call must produce useful work for the owner.",
          "- For stable Forum/Counsel seats, prefer sessions_send to agent:<seat-id>:main; do not sessions_spawn those seats for ordinary room turns, greetings, checks, or short advice.",
          "- Directly addressed seat: one adviser call, no automatic synthesis.",
          "- Forum 'everyone': at most three independent adviser calls. Add one separate synthesis call only when synthesis is requested, using the model/seat selected for that run; no numbered seat has permanent synthesis authority. No research for greetings/check-ins. A second adviser round requires a material contradiction/gap or an explicit owner request.",
          "- Counsel 'everyone': at most three independent seat calls. Add one separate synthesis call only when synthesis is requested, using the model/seat selected for that run; no numbered seat has permanent synthesis authority. Do not silently substitute another model for a failed named seat; report the seat unavailable unless the owner asks for a fallback.",
          "- Research: quick uses one researcher; standard uses at most two. Do not duplicate browsing across advisers. Deep follow-up is targeted to unresolved gaps only.",
          "- Never poll sessions_list or sessions_history in a loop waiting for completion. Use the supported wait/yield/completion path once.",
          "- One failed room/model call gets at most one changed-method retry. Do not create replacement-agent herds.",
          "- Automatic Memory Core Dreaming is enabled for permanent memory consolidation. Skill Workshop autonomous review remains off and is used only on explicit owner request.",
          "- Do not impose Jarvis-specific output-token ceilings. Let each provider/model use its native output and reasoning capacity.",
          "- Large artifacts may use the model/provider native capacity. Financial control belongs at the prepaid OpenRouter balance; behavioral safety comes from loop, recursion, concurrency, and tool-policy controls.",
          "",
        ].join("\n");
        agentsText = agentsText.trimEnd() + "\n\n" + nrtPolicy;
        fs.writeFileSync(agentsPolicyPath, agentsText, { encoding: "utf8", mode: 0o600 });
      } else {
        const oldPolicyLines = [
          "- The standard model request envelope is 32k. Treat it as an admission/reasoning envelope, not a spend throttle; actual usage is metered from generated tokens.",
          "- Large artifacts should normally be written coherently in sections/files. Raise the per-job ceiling above 32k only when the requested deliverable genuinely benefits from one-shot generation; never restore 128k+ as the global default.",
          "- Background learning/review is off. Use Skill Workshop only on explicit owner request.",
        ];
        const newPolicyLines = [
          "- Do not impose Jarvis-specific output-token ceilings. Let each provider/model use its native output and reasoning capacity.",
          "- Large artifacts may use the model/provider native capacity. Financial control belongs at the prepaid OpenRouter balance; behavioral safety comes from loop, recursion, concurrency, and tool-policy controls.",
          "- Automatic Memory Core Dreaming is enabled for permanent memory consolidation. Skill Workshop autonomous review remains off and is used only on explicit owner request.",
        ];
        let changed = false;
        for (let i = 0; i < oldPolicyLines.length; i += 1) {
          if (agentsText.includes(oldPolicyLines[i])) {
            agentsText = agentsText.replace(oldPolicyLines[i], newPolicyLines[i]);
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(agentsPolicyPath, agentsText, { encoding: "utf8", mode: 0o600 });
          console.log("[wrapper] removed stale 32k policy text from AGENTS.md");
        }
      }
    }

    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log("[wrapper] Jarvis operational defaults + non-revenue-token controls applied");
  } catch (err) {
    console.warn(`[wrapper] failed to apply Jarvis operational defaults: ${String(err)}`);
  }
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Apply private workspace seed from Railway-only payload, if present.
  applyPrivateWorkspaceSeed(WORKSPACE_DIR);

  // Install the controlled permanent-agent factory after canonical seat reconciliation.
  installJarvisAgentFactoryV1(WORKSPACE_DIR);

  // Install the official Lobster workflow plugin into persistent OpenClaw state.
  // Best-effort: a package/network failure must not prevent Jarvis from starting.
  await ensureJarvisLobsterV1();

  // Apply Jarvis operational tool/browser settings directly, avoiding slow CLI chains.
  applyJarvisOperationalDefaults();

  // OpenRouter server-tool research commissioning is gateway-independent.
  launchJarvisResearchCommissioningV1();

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Sync gateway tokens in config with the current env var on every startup.
  // This prevents "gateway token mismatch" when OPENCLAW_GATEWAY_TOKEN changes
  // (e.g. Railway variable update) but the config file still has the old value.
  if (isConfigured() && OPENCLAW_GATEWAY_TOKEN) {
    console.log("[wrapper] syncing gateway tokens in config...");
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] gateway tokens synced");
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway tokens: ${String(err)}`);
    }
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
      await runJarvisMainSessionRecoveryV1();
      const c1FreshReady = await runC1FreshFloorV1();
      if (c1FreshReady) await runC1ContextDiagnosticV1("current");
      await runB8MemoryDiagnosticV1();
      await runB8MemoryDiagnosticV2();
      await runC2OutputEnvelopeDiagnosticV1();
      await runC2CacheProofV2();
      await runC2CacheInspectV1();
      launchOpenRouterKeyAuditV1();
      launchJarvisSecurityAuditV1();
      launchJarvisAgentSmokeV1();
      launchJarvisAdviserMemoryCommissioningV1();
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
      // Railway can briefly overlap old/new containers on the same persistent volume.
      // OpenClaw's gateway-owner lease may therefore outlive the old container for a few
      // minutes. Retry automatically so Jarvis recovers without a manual restart.
      const gatewayRetryTimer = setInterval(async () => {
        try {
          console.log("[wrapper] retrying gateway startup...");
          await ensureGatewayRunning();
          console.log("[wrapper] gateway ready after retry");
          clearInterval(gatewayRetryTimer);
          const c1FreshReady = await runC1FreshFloorV1();
          if (c1FreshReady) await runC1ContextDiagnosticV1("current");
          await runB8MemoryDiagnosticV1();
      await runB8MemoryDiagnosticV2();
          await runC2OutputEnvelopeDiagnosticV1();
          await runC2CacheProofV2();
          await runC2CacheInspectV1();
          launchJarvisSecurityAuditV1();
          launchJarvisAgentSmokeV1();
          launchJarvisAdviserMemoryCommissioningV1();
        } catch (retryErr) {
          console.warn(`[wrapper] gateway retry not ready yet: ${String(retryErr)}`);
        }
      }, 45_000);
      gatewayRetryTimer.unref?.();
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // Note: browsers cannot attach arbitrary HTTP headers (including Authorization: Basic)
  // in WebSocket handshakes. Do not enforce dashboard Basic auth at the upgrade layer.
  // The gateway authenticates at the protocol layer and we inject the gateway token below.

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

let shutdownStarted = false;

async function shutdownGracefully(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[wrapper] received ${signal}; shutting down gateway cleanly...`);

  const child = gatewayProc;
  if (child) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
      setTimeout(finish, 8_000).unref?.();
    });
  }

  await new Promise((resolve) => {
    try {
      server.close(resolve);
    } catch {
      resolve();
    }
    setTimeout(resolve, 2_000).unref?.();
  });

  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdownGracefully("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdownGracefully("SIGINT");
});
