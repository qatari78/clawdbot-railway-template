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
import { applyJarvisResearchSystemV1, researchPaths } from "./jarvis-research-system-v1.js";
import { applyJarvisSeatConfigV1, modelRefOf } from "./jarvis-seat-config-v1.js";
import { runJarvisResearchCommissioningV1 } from "./jarvis-research-commissioning.js";
import { createSafety } from "./salem-safety.js";
import { createPeers } from "./salem-peers.js";
import { findGatewayPids, processAlive, descendantPids } from "./salem-procs.js";
import { createMeter } from "./salem-meter.js";
import { createOwnerApprovals, isLoopbackRequest } from "./salem-approvals.js";

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

// D2 (2026-09-26): wrapper-only secrets never reach the gateway, its agents' shells, or
// any CLI the wrapper runs. A stray `env` in an agent shell can then not leak the setup
// password, the backup token or the private workspace seed into a chat or a transcript.
const WRAPPER_ONLY_ENV = [
  /^SETUP_PASSWORD$/,
  /^BACKUP_EXPORT_TOKEN$/,
  /^OPENCLAW_PRIVATE_WORKSPACE_SEED/,
  /^JARVIS_SEED_/,
  /^OPENCLAW_DEBUG_/,
  /^WATCHDOG_/,
];
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!WRAPPER_ONLY_ENV.some((re) => re.test(k))) env[k] = v;
  }
  return { ...env, OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR, ...extra };
}

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

// Salem AI safety net (Claude, 2026-09-26): stop latch, owner alerts, money fuse, watchdog budget.
const safety = createSafety({ stateDir: STATE_DIR, configPath: configPath(), log: console });
// R8: other copies of this wrapper on the same volume (deploy overlap, leftover failed release).
const peers = createPeers({ stateDir: STATE_DIR, log: console });
const WRAPPER_STARTED_AT = Date.now();
let watchdogFailures = 0;
let watchdogBusy = false;
let watchdogTest = false; // set by gateway.crash-test: the next watchdog restart is a silent, uncounted test
let gatewayLifecycleBusy = false; // a deliberate stop/restart is in progress; the watchdog stays out of it
let restoreInProgress = false; // backup import: nothing may start the gateway until the files are in place
const GATEWAY_SETTLE_MS = 8_000; // a start counts only if the new gateway process is still up after this
let bootStartPending = false; // boot start (or its retries) still owns bringing the gateway up
let untrackedLogged = false;
const isStandby = () => peers.status(Boolean(gatewayProc)).standby;

// Gateway RPC for wrapper jobs (meter, pin checks). Throws on failure; returns the result object.
async function gatewayCallJson(method, params, timeoutMs = 90_000) {
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["gateway", "call", method, "--params", JSON.stringify(params ?? {}), "--json", "--timeout", String(Math.max(10_000, timeoutMs - 15_000))]),
    { timeoutMs },
  );
  if (r.code !== 0) throw new Error(`${method} failed (exit ${r.code}): ${redactSecrets(String(r.output || "")).slice(0, 200)}`);
  const text = String(r.output || "");
  let data = null;
  try { data = JSON.parse(text.trim()); } catch {
    const at = text.search(/^\{/m);
    if (at >= 0) { try { data = JSON.parse(text.slice(at).trim()); } catch {} }
    if (!data) data = parseJsonFromOutput(text);
  }
  if (!data || typeof data !== "object") throw new Error(`${method}: unparseable output`);
  return data.result ?? data;
}

function ownerWhatsAppE164() {
  const fromEnv = process.env.JARVIS_WHATSAPP_OWNER_E164?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const list = cfg.channels?.whatsapp?.allowFrom;
    return Array.isArray(list) ? list.find((x) => /^\+\d{6,}$/.test(String(x))) ?? null : null;
  } catch { return null; }
}

// Salem AI smart meter (C3/C4/G2): numbers from OpenClaw's usage rollups and OpenRouter.
const meter = createMeter({
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  dataDir: path.dirname(STATE_DIR),
  researchRunsDir: researchPaths().runs, // R14: research-runner cost counts in the meter
  gatewayCall: (method, params) => gatewayCallJson(method, params, 150_000),
  sendWhatsApp: async (text) => {
    const to = ownerWhatsAppE164();
    if (!to) return { ok: false, error: "no owner WhatsApp number" };
    if (!gatewayProc || safety.isLatched()) return { ok: false, error: "gateway not running" };
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["message", "send", "--channel", "whatsapp", "-t", to, "-m", text, "--json"]), { timeoutMs: 90_000 });
    return r.code === 0 ? { ok: true } : { ok: false, error: redactSecrets(String(r.output || "")).slice(0, 200) };
  },
  sendTelegram: (text) => safety.sendTelegramText(text),
  fuseStatus: () => safety.fuseStatus(),
  spendSamples: () => safety.spendSamples(),
  lineup: () => { try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIR, "reports", "lineup.json"), "utf8")); } catch { return null; } },
  canQuery: () => Boolean(gatewayProc) && !safety.isLatched(),
  log: console,
});

// Hard stop: SIGTERM, then SIGKILL if the gateway is still draining after hardAfterMs (OpenClaw
// otherwise drains for up to ~5 minutes and keeps its lock, so a new gateway cannot start).
// R8: waits until the process is really gone, and also stops gateway processes the wrapper is
// not tracking, so "stop" always means stopped (owner stop, money fuse, restart, import).
async function stopGatewayProc({ hardAfterMs = 10_000 } = {}) {
  const child = gatewayProc;
  let stopped = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    // R9: note everything the gateway started (exec sessions, research runner, spawn broker)
    // before stopping it; once the gateway is gone they are re-parented and would keep running
    // (and spending) after a stop. Seen 26 Sep: the research runner outlived a stop.
    let tree = descendantPids(child.pid);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once("exit", finish);
      try { child.kill("SIGTERM"); } catch { finish(); }
      setTimeout(() => {
        tree = Array.from(new Set([...tree, ...descendantPids(child.pid)]));
        try { child.kill("SIGKILL"); } catch {}
        setTimeout(finish, 2_000);
      }, hardAfterMs).unref?.();
    });
    stopped = true;
    await killPids(tree, { label: "left over from the gateway" });
  }
  if (gatewayProc === child) gatewayProc = null;
  if (await killStrayGateways({ hardAfterMs })) stopped = true;
  peers.beat(Boolean(gatewayProc));
  return stopped;
}

async function killPids(pids, { label = "", hardAfterMs = 3_000 } = {}) {
  const alive = pids.filter((pid) => processAlive(pid));
  if (!alive.length) return 0;
  console.warn(`[gateway] stopping ${alive.length} process(es) ${label}: ${alive.join(", ")}`);
  for (const pid of alive) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + hardAfterMs;
  while (Date.now() < deadline && alive.some((pid) => processAlive(pid))) await sleep(200);
  for (const pid of alive) { if (processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
  return alive.length;
}

// Gateway processes in this container that the wrapper is not tracking.
function strayGatewayPids() {
  return findGatewayPids({ port: INTERNAL_GATEWAY_PORT, excludePids: gatewayProc?.pid ? [gatewayProc.pid] : [] });
}

async function killStrayGateways({ hardAfterMs = 10_000 } = {}) {
  const pids = strayGatewayPids();
  if (!pids.length) return false;
  const trees = pids.flatMap((pid) => descendantPids(pid));
  console.warn(`[gateway] stopping ${pids.length} untracked gateway process(es): ${pids.join(", ")}`);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + hardAfterMs;
  while (Date.now() < deadline && pids.some((pid) => processAlive(pid))) await sleep(250);
  for (const pid of pids) { if (processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
  const until = Date.now() + 3_000;
  while (Date.now() < until && pids.some((pid) => processAlive(pid))) await sleep(100);
  await killPids(trees, { label: "left over from an untracked gateway" });
  return true;
}

// Responsiveness check: the gateway must answer an HTTP request, not merely accept a TCP connect.
async function gatewayResponds(timeoutMs = 8_000) {
  try {
    const res = await fetch(`${GATEWAY_TARGET}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(res);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const child = opts.child ?? null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // R8: if our gateway process already exited, a response on the port would come from some
    // other process (e.g. an old gateway still draining) — not a successful start.
    if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
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

  const child = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: childEnv(),
  });
  gatewayProc = child;
  untrackedLogged = false;
  peers.beat(true);

  // R8: handlers only clear the reference for their own process. An old gateway that exits
  // late must not wipe the reference to the new one (that made the wrapper start extra
  // gateways which exited 78 while the real one kept running untracked).
  child.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    if (gatewayProc === child) gatewayProc = null;
    peers.beat(Boolean(gatewayProc));
  });

  child.on("exit", (code, signal) => {
    // Exit 78: another healthy OpenClaw gateway already owns this state directory (OpenClaw's
    // supervisor contract) — not a crash.
    const note = code === 78 ? " (another gateway already owns the state — not a crash)" : "";
    console.error(`[gateway] exited code=${code} signal=${signal} pid=${child.pid}${note}`);
    lastGatewayExit = { code, signal, pid: child.pid, at: new Date().toISOString() };
    if (gatewayProc === child) gatewayProc = null;
    peers.beat(Boolean(gatewayProc));
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

// R8: `attempts` > 1 retries a start that fails quickly (e.g. the previous owner's lock is
// still being released); a copy on standby never starts a gateway.
async function ensureGatewayRunning({ attempts = 1, retryDelayMs = 10_000 } = {}) {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  const latch = safety.latchInfo();
  if (latch) throw new Error(`stopped-by-owner (${latch.reason}); start it from /setup when ready`);
  if (gatewayProc) return { ok: true };
  if (restoreInProgress) throw new Error("restore in progress; the gateway starts when it is done");
  const sb = peers.status(false);
  if (sb.standby) throw new Error(`standby: ${sb.reason}`);
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      let lastErr = null;
      for (let i = 1; i <= Math.max(1, attempts); i++) {
        try {
          lastGatewayError = null;
          // Re-checked before every attempt: the owner may have stopped Jarvis, a restore may have
          // begun, or another copy may have taken over while we were retrying.
          if (safety.isLatched()) throw new Error("stopped-by-owner");
          if (restoreInProgress) throw new Error("restore in progress");
          const sbNow = peers.status(Boolean(gatewayProc));
          if (sbNow.standby) throw new Error(`standby: ${sbNow.reason}`);
          await startGateway();
          const child = gatewayProc;
          const spawnedAt = Date.now();
          let ready = await waitForGatewayReady({ timeoutMs: 30_000, child });
          // A new gateway that finds another healthy gateway in control exits 78 within a few
          // seconds, and meanwhile the port answers for the other one. Only call it ready once
          // our process has stayed up for a few seconds.
          if (ready) {
            const settle = GATEWAY_SETTLE_MS - (Date.now() - spawnedAt);
            if (settle > 0) await sleep(settle);
            ready = gatewayProc === child && child.exitCode === null && child.signalCode === null;
          }
          if (ready) return;
          lastErr = new Error(child && child.exitCode === null && child.signalCode === null
            ? "Gateway did not become ready in time"
            : `Gateway exited during startup (${lastGatewayExit?.code != null ? `code ${lastGatewayExit.code}` : `signal ${lastGatewayExit?.signal ?? "?"}`})`);
        } catch (err) {
          lastErr = err;
          if (/stopped-by-owner|standby:|restore in progress/.test(String(err))) break;
        }
        if (i < attempts) {
          console.warn(`[gateway] start attempt ${i}/${attempts} failed: ${String(lastErr)}; retrying in ${Math.round(retryDelayMs / 1000)}s`);
          await sleep(retryDelayMs);
        }
      }
      lastGatewayError = `[gateway] start failure: ${String(lastErr)}`;
      // Collect extra diagnostics to help users file issues.
      await runDoctorBestEffort();
      throw lastErr ?? new Error("Gateway did not start");
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

// R8: a restart waits until the old gateway is really gone (hard stop after 15 s) before starting
// the new one. Before, the old gateway kept draining for ~5 minutes while holding its lock, each
// new gateway exited 78, and the watchdog counted those as crashes (the 26 Sep false alerts).
async function restartGateway({ attempts = 6 } = {}) {
  gatewayLifecycleBusy = true;
  try {
    await stopGatewayProc({ hardAfterMs: 15_000 });
    return await ensureGatewayRunning({ attempts, retryDelayMs: 10_000 });
  } finally {
    gatewayLifecycleBusy = false;
  }
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

function parseJsonFromOutput(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  for (let j = s.lastIndexOf("}"); j > i; j = s.lastIndexOf("}", j - 1)) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch {}
  }
  return null;
}

function findKeyDeep(obj, name, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  for (const v of Object.values(obj)) {
    const found = findKeyDeep(v, name, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Seat sessions must answer with the seat's configured model. A per-session pin
// (e.g. `/model <x>` typed inside a seat session) silently substitutes another model
// for room work; on 2026-09-26 Counsel 1's room session was pinned to Gemini Flash
// while the seat was configured as Opus 5.5. Clear such pins after the gateway is up.
async function reconcileSeatSessionPinsV1() {
  // v3 (2026-09-26): every session of every seat agent, not just agent:<id>:main.
  // A session-level model pin left from an earlier setup (e.g. Salem's WhatsApp chat still
  // pinned to Grok after Jarvis moved to Sol) silently overrides the seat's model; clear it.
  // Test sessions are ignored. An owner pin that equals the seat's model is kept.
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return; }
  const call = (method, params) => runCmd(
    OPENCLAW_NODE,
    clawArgs(["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", "30000"]),
    { timeoutMs: 40_000 },
  );
  const collectRows = (obj, out = [], depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 6) return out;
    if (typeof obj.key === "string" && obj.key.startsWith("agent:")) { out.push(obj); return out; }
    for (const v of Object.values(obj)) collectRows(v, out, depth + 1);
    return out;
  };
  const report = [];
  for (const id of ["main", "forum-01", "forum-02", "forum-03", "counsel-01", "counsel-02", "counsel-03", "research-01", "research-02"]) {
    const configured = modelRefOf(cfg.agents?.entries?.[id]?.model);
    if (!configured) continue;
    try {
      const listed = await call("sessions.list", { agentId: id, limit: 500 });
      const data = parseJsonFromOutput(listed.output);
      if (listed.code !== 0 || !data) {
        report.push({ id, state: "unknown", code: listed.code, head: redactSecrets(String(listed.output || "")).slice(0, 160) });
        continue;
      }
      const rows = collectRows(data).filter((r) => r.key.startsWith(`agent:${id}:`) && !r.key.includes(":explicit:claude-test-"));
      let cleared = 0; let kept = 0; let failed = 0;
      for (const row of rows) {
        const model = row.modelOverride ?? findKeyDeep(row, "modelOverride");
        const provider = row.providerOverride ?? findKeyDeep(row, "providerOverride");
        const source = row.modelOverrideSource ?? findKeyDeep(row, "modelOverrideSource");
        if (!model || source === "default") continue;
        const m = String(model);
        const pinned = provider && !m.startsWith(`${provider}/`) ? `${provider}/${m}` : m;
        if (pinned === configured) { kept += 1; continue; }
        const r = await call("sessions.patch", { key: row.key, model: null });
        if (r.code === 0) cleared += 1; else failed += 1;
        console.log(`[seat-pins-v3] ${r.code === 0 ? "cleared" : "clear-failed"} ${row.key} pinned=${pinned} seat=${configured}`);
      }
      report.push({ id, sessions: rows.length, cleared, kept, failed });
    } catch (err) {
      report.push({ id, state: "error", error: redactSecrets(String(err)).slice(0, 160) });
    }
  }
  console.log("[seat-pins-v3] " + JSON.stringify(report));
  return report;
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

// D4 owner approvals (2026-09-26): see salem-approvals.js. Loopback callers only.
const ownerApprovals = createOwnerApprovals({ send: (text) => safety.sendTelegramText(text) });
function localOnly(req, res, next) {
  if (!isLoopbackRequest(req)) return res.status(404).send("Not found");
  return next();
}
app.post("/internal/owner-approval/request", localOnly, async (req, res) => {
  const { kind, ref, summary } = req.body || {};
  const r = await ownerApprovals.request(kind, ref, summary);
  console.log(`[owner-approval-v1] request ${String(kind).slice(0, 40)}:${String(ref).slice(0, 80)} ${r.ok ? "sent" : r.error}`);
  return res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true, sentTo: "owner's Telegram", expiresAt: r.expiresAt } : { ok: false, error: r.error });
});
app.post("/internal/owner-approval/verify", localOnly, (req, res) => {
  const { kind, ref, code } = req.body || {};
  const r = ownerApprovals.verify(kind, ref, code);
  console.log(`[owner-approval-v1] verify ${String(kind).slice(0, 40)}:${String(ref).slice(0, 80)} ${r.ok ? "ok" : r.error}`);
  return res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

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
// B1: /healthz tells the truth. 200 only when the gateway is running and answering;
// 503 (with a reason) when it is stopped, starting, unreachable or deliberately latched.
// Railway's deploy healthcheck uses /setup/healthz (wrapper liveness) per railway.toml.
app.get("/healthz", async (_req, res) => {
  if (!isConfigured()) return res.status(503).json({ ok: false, state: "not-configured", gatewayReachable: false });
  const latch = safety.latchInfo();
  if (latch) return res.status(503).json({ ok: false, state: "stopped-by-owner", latch, gatewayReachable: false });
  let gatewayReachable = false;
  try { gatewayReachable = await probeGateway(); } catch { gatewayReachable = false; }
  if (!gatewayReachable) {
    return res.status(503).json({ ok: false, state: gatewayStarting ? "starting" : "gateway-unreachable", gatewayReachable: false, lastGatewayExit });
  }
  return res.json({ ok: true, state: "running", gatewayReachable: true });
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

    const { extraEnv, ...spawnOpts } = opts;
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: childEnv(extraEnv && typeof extraEnv === "object" ? extraEnv : {}),
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
  "latch.status",
  "fuse.status",
  "fuse.check",
  "fuse.test",
  "gateway.crash-test",
  "watchdog.status",
  "watchdog.reset",
  "wrapper.info",
  "cache.trace",
  "cache.probe",
  "meter.testday",
  "alert.test",
  "openclaw.gateway.call",
  "test.turn",
  "test.cleanup",
  "meter.run",
  "meter.state",
  "meter.top",
  "report.daily.preview",
  "report.daily.send",
  "report.weekly.preview",
  "report.weekly.send",
  "privacy.check",
  "pins.reconcile",
  "disk.usage",
  "research.test",
  "research.runs",
  "seat.set",

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
      // B5: a deliberate stop latches — watchdog, UI visits and container restarts will not revive it.
      safety.setLatch(arg === "commissioning-test" ? "commissioning-test" : "owner-console", "setup");
      gatewayLifecycleBusy = true;
      try { await stopGatewayProc({ hardAfterMs: 10_000 }); } finally { gatewayLifecycleBusy = false; }
      return res.json({ ok: true, output: "Gateway stopped and latched (stays stopped until gateway.start).\n" });
    }
    if (cmd === "gateway.start") {
      safety.clearLatch("setup");
      gatewayLifecycleBusy = true;
      let r;
      try { r = await ensureGatewayRunning({ attempts: 3, retryDelayMs: 10_000 }); } finally { gatewayLifecycleBusy = false; }
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Latch cleared. Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }
    if (cmd === "latch.status") {
      return res.json({ ok: true, output: JSON.stringify({ latch: safety.latchInfo(), gatewayRunning: Boolean(gatewayProc) }, null, 2) + "\n" });
    }
    if (cmd === "fuse.status") {
      return res.json({ ok: true, output: JSON.stringify(safety.fuseStatus(), null, 2) + "\n" });
    }
    if (cmd === "fuse.test") {
      // B3 proof with lowered thresholds, dry run: real spend numbers, stop level set below them,
      // Jarvis is NOT stopped; the owner gets a clearly labelled test alert.
      const f = await safety.fuseTick({
        stopGateway: async () => {},
        thresholdsOverride: { alertPerHour: 0, stopPerHour: 0.000001, dryRun: true },
        label: "fuse test by Claude — no action needed",
      });
      return res.json({ ok: true, output: JSON.stringify(f, null, 2) + "\n" });
    }
    if (cmd === "gateway.crash-test") {
      // B2 proof: kill the gateway WITHOUT latching; the watchdog must bring it back within ~2 min.
      // R8: a test restart is silent (no owner alert) and does not use the real restart budget.
      if (!gatewayProc) return res.json({ ok: false, output: "gateway not running\n" });
      watchdogTest = true;
      try { gatewayProc.kill("SIGKILL"); } catch {}
      return res.json({ ok: true, output: "Gateway killed (SIGKILL, no latch). The watchdog should restart it within about 2 minutes (test: no alert).\n" });
    }
    if (cmd === "watchdog.reset") {
      // Clears restart-budget entries (e.g. restarts caused by a known bug, or by tests).
      const before = safety.restartBudget();
      safety.resetRestarts();
      return res.json({ ok: true, output: JSON.stringify({ cleared: before.recent.length, budget: safety.restartBudget() }) + "\n" });
    }
    if (cmd === "cache.trace") {
      // R9 diagnostic: why Jarvis's conversation is re-written to the prompt cache on every call.
      // on/off toggles OpenClaw's cache trace; report[:<session filter>] compares consecutive
      // requests of a session and shows where they first differ; clear deletes the trace file.
      const [action, filter = ""] = String(arg || "report").split(/:(.*)/s);
      const tracePath = path.join(STATE_DIR, "logs", "cache-trace.jsonl");
      if (action === "on" || action === "off") {
        const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "diagnostics.cacheTrace.enabled", action === "on" ? "true" : "false"]));
        return res.json({ ok: r.code === 0, output: redactSecrets(String(r.output || "")).slice(0, 600) });
      }
      if (action === "clear") {
        try { fs.rmSync(tracePath, { force: true }); } catch {}
        return res.json({ ok: true, output: "cache trace file deleted\n" });
      }
      let text = "";
      try {
        const st = fs.statSync(tracePath);
        const len = Math.min(st.size, 24 * 1024 * 1024);
        const fd = fs.openSync(tracePath, "r");
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        text = buf.toString("utf8");
      } catch (err) {
        return res.json({ ok: false, output: `no cache trace yet: ${String(err).slice(0, 160)}\n` });
      }
      const events = text.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && (!filter || String(e.sessionKey || "").includes(filter)));
      const stages = {};
      for (const e of events) stages[e.stage] = (stages[e.stage] || 0) + 1;
      const textOf = (m) => (m == null ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m));
      const around = (t, at) => t.slice(Math.max(0, at - 80), at + 220);
      const ctx = events.filter((e) => e.stage === "stream:context" && Array.isArray(e.messageFingerprints));
      const pairs = [];
      for (let i = 1; i < ctx.length; i++) {
        const a = ctx[i - 1];
        const b = ctx[i];
        if (a.sessionKey !== b.sessionKey) continue;
        const fa = a.messageFingerprints;
        const fb = b.messageFingerprints;
        let k = 0;
        while (k < fa.length && k < fb.length && fa[k] === fb[k]) k++;
        const pair = { seq: [a.seq, b.seq], run: [String(a.runId || "").slice(0, 8), String(b.runId || "").slice(0, 8)], messages: [fa.length, fb.length], sameSystem: a.systemDigest === b.systemDigest, firstDifferentMessage: k < fa.length ? k : null };
        if (k < fa.length && Array.isArray(a.messages) && Array.isArray(b.messages)) {
          const ta = textOf(a.messages[k]);
          const tb = textOf(b.messages[k]);
          let c = 0;
          while (c < ta.length && c < tb.length && ta[c] === tb[c]) c++;
          pair.role = [a.messages[k]?.role, b.messages[k]?.role];
          pair.charOffset = c;
          pair.before = around(ta, c);
          pair.after = around(tb, c);
        }
        pairs.push(pair);
      }
      return res.json({ ok: true, output: JSON.stringify({ events: events.length, stages, pairs: pairs.slice(-12) }, null, 2) + "\n" });
    }
    if (cmd === "cache.probe") {
      // R9b diagnostic (≈$0.15): does OpenRouter reuse a conversation prefix for this model?
      // "plain" mimics today's requests (no markers; a runtime-context message at the end, which
      // changes every request). "marked" adds Anthropic-style cache_control markers on the
      // system prompt and the latest real message, skipping the runtime-context message — the
      // layout OpenClaw applies with compat.cacheControlFormat "anthropic".
      const model = String(arg || "openai/gpt-6-sol").trim();
      const nonce = crypto.randomUUID().slice(0, 8);
      const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}-${nonce} line ${i}: the quick brown fox jumps over the lazy dog by the old stone bridge.`).join("\n");
      const S = `You are a test assistant. Answer with one word.\n${lines(600, "sys")}`;
      const U1 = `${lines(150, "u1")}\nReply with just: one`;
      const U2 = "Reply with just: two";
      const carrier = (i) => `[runtime context ${i} at ${new Date().toISOString()}]`;
      const call = async (messages) => {
        const r = await safety.openRouterRequest("/chat/completions", { method: "POST", body: { model, messages, max_tokens: 16, provider: { data_collection: "deny" }, usage: { include: true } } });
        const u = r.json?.usage ?? {};
        return { status: r.status, prompt: u.prompt_tokens, cached: u.prompt_tokens_details?.cached_tokens ?? null, write: u.prompt_tokens_details?.cache_write_tokens ?? null, cost: u.cost ?? null, provider: r.json?.provider ?? null, reply: String(r.json?.choices?.[0]?.message?.content ?? "").slice(0, 20), err: r.ok ? undefined : JSON.stringify(r.json ?? {}).slice(0, 300) };
      };
      const mark = (text) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];
      const results = {};
      for (const variant of ["plain", "marked"]) {
        const m = variant === "marked";
        const tag = `${variant}-${nonce}`;
        const sysText = `${S}\nvariant ${tag}`;
        const sys = { role: "system", content: m ? mark(sysText) : sysText };
        const r1 = await call([sys, { role: "user", content: m ? mark(U1) : U1 }, { role: "user", content: carrier(1) }]);
        const a1 = { role: "assistant", content: r1.reply || "one" };
        const r2 = await call([sys, { role: "user", content: U1 }, a1, { role: "user", content: m ? mark(U2) : U2 }, { role: "user", content: carrier(2) }]);
        const a2 = { role: "assistant", content: r2.reply || "two" };
        const r3 = await call([sys, { role: "user", content: U1 }, a1, { role: "user", content: U2 }, a2, { role: "user", content: m ? mark("Reply with just: three") : "Reply with just: three" }, { role: "user", content: carrier(3) }]);
        results[variant] = { r1, r2, r3 };
      }
      // Same layout as OpenClaw's marker policy with tools: last tool marked, tool round with
      // a marked tool result. Checks that the route accepts markers on tools and tool results.
      {
        const tag = `tools-${nonce}`;
        const tools = [
          { type: "function", function: { name: "exec", description: "Run a short program.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } } },
          { type: "function", function: { name: "wait", description: "Wait for a pending run.", parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } }, cache_control: { type: "ephemeral" } },
        ];
        const sys = { role: "system", content: mark(`${S}\nvariant ${tag}`) };
        const callT = async (messages) => {
          const r = await safety.openRouterRequest("/chat/completions", { method: "POST", body: { model, messages, tools, max_tokens: 16, provider: { data_collection: "deny" }, usage: { include: true } } });
          const u = r.json?.usage ?? {};
          return { status: r.status, prompt: u.prompt_tokens, cached: u.prompt_tokens_details?.cached_tokens ?? null, write: u.prompt_tokens_details?.cache_write_tokens ?? null, cost: u.cost ?? null, err: r.ok ? undefined : JSON.stringify(r.json ?? {}).slice(0, 300) };
        };
        const r1 = await callT([sys, { role: "user", content: mark(U1) }, { role: "user", content: carrier(1) }]);
        const call = { id: "call_probe_1", type: "function", function: { name: "exec", arguments: "{\"code\":\"1+1\"}" } };
        const r2 = await callT([sys, { role: "user", content: U1 }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_probe_1", content: mark("2") }, { role: "user", content: carrier(2) }]);
        results.tools = { r1, r2 };
      }
      return res.json({ ok: true, output: JSON.stringify({ model, results }, null, 2) + "\n" });
    }
    if (cmd === "wrapper.info") {
      const allGateways = findGatewayPids({ port: INTERNAL_GATEWAY_PORT });
      return res.json({ ok: true, output: JSON.stringify({
        pid: process.pid,
        startedAt: new Date(WRAPPER_STARTED_AT).toISOString(),
        uptimeSec: Math.round((Date.now() - WRAPPER_STARTED_AT) / 1000),
        deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
        gatewayPid: gatewayProc?.pid ?? null,
        gatewayStarting: Boolean(gatewayStarting),
        gatewayPidsFound: allGateways,
        untrackedGatewayPids: strayGatewayPids(),
        lastGatewayExit,
        lastGatewayError,
        bootStartPending,
        latch: safety.latchInfo(),
        budget: safety.restartBudget(),
        peers: peers.info(),
        recentAlerts: safety.recentAlerts(8),
      }, null, 2) + "\n" });
    }
    if (cmd === "fuse.check") {
      const f = await safety.fuseTick({ stopGateway: () => stopGatewayProc({ hardAfterMs: 10_000 }) });
      return res.json({ ok: true, output: JSON.stringify(f, null, 2) + "\n" });
    }
    if (cmd === "watchdog.status") {
      return res.json({ ok: true, output: JSON.stringify({ failures: watchdogFailures, budget: safety.restartBudget(), alertTarget: safety.alertTarget() }, null, 2) + "\n" });
    }
    if (cmd === "alert.test") {
      const r = await safety.sendAlert("test", arg || "TEST alert from the Salem AI safety net — no action needed.", { force: true });
      return res.json({ ok: Boolean(r.ok), output: JSON.stringify(r) + "\n" });
    }
    if (cmd === "test.turn") {
      // One real agent turn in an isolated test session (agent:<id>:explicit:claude-test-<suffix>);
      // not channel-bound, so nothing is delivered to WhatsApp/Telegram. Used for commissioning tests.
      let spec;
      try { spec = JSON.parse(arg || "{}"); } catch { return res.status(400).json({ ok: false, error: "arg must be JSON" }); }
      const agentId = String(spec.agentId || "");
      const suffix = String(spec.suffix || "");
      const message = String(spec.message || "");
      if (!/^(main|forum-0[1-3]|counsel-0[1-3]|research-0[12])$/.test(agentId)) return res.status(400).json({ ok: false, error: "bad agentId" });
      if (!/^[a-z0-9-]{1,40}$/.test(suffix) || !message || message.length > 6000) return res.status(400).json({ ok: false, error: "bad suffix/message" });
      const args = ["agent", "--agent", agentId, "--session-key", `agent:${agentId}:explicit:claude-test-${suffix}`, "--message", message, "--json", "--timeout", String(Math.min(1800, Number(spec.timeout) || 600))];
      if (typeof spec.model === "string" && /^[a-z0-9._\/-]{3,120}$/i.test(spec.model)) args.push("--model", spec.model);
      if (typeof spec.thinking === "string" && /^[a-z-]{2,20}$/.test(spec.thinking)) args.push("--thinking", spec.thinking);
      const t0 = Date.now();
      const r = await runCmd(OPENCLAW_NODE, clawArgs(args), { timeoutMs: (Math.min(1800, Number(spec.timeout) || 600) + 60) * 1000 });
      const out = redactSecrets(r.output || "");
      return res.status(200).json({ ok: r.code === 0, output: JSON.stringify({ code: r.code, wallMs: Date.now() - t0, output: out.length > 40_000 ? out.slice(0, 40_000) + "...(truncated)" : out }) });
    }
    if (cmd === "meter.run") {
      const r = await meter.refreshLatest();
      return res.json({ ok: true, output: JSON.stringify({ today: r.today.text, yesterday: r.yesterday.text, todayDay: { ...r.today.day, topTasks: undefined }, cacheStatus: r.today.day.cacheStatus, railway: r.today.railway }, null, 2) + "\n" });
    }
    if (cmd === "meter.top") {
      // Most expensive sessions of one day (numbers only), e.g. to explain a spend spike.
      const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
      const r = await gatewayCallJson("sessions.usage", { agentScope: "all", startDate: date, endDate: date, mode: "specific", timeZone: "Asia/Qatar", limit: 2000 }, 150_000);
      const rows = (r?.sessions ?? []).map((x) => ({
        key: x.key, agent: x.agentId, cost: Math.round((x.usage?.totalCost ?? 0) * 1000) / 1000,
        input: x.usage?.input, cacheRead: x.usage?.cacheRead, cacheWrite: x.usage?.cacheWrite, output: x.usage?.output,
        replies: x.usage?.messageCounts?.assistant, toolCalls: x.usage?.messageCounts?.toolCalls,
        models: (x.usage?.modelUsage ?? []).map((m) => `${m.model} ×${m.count} $${Math.round((m.totals?.totalCost ?? 0) * 1000) / 1000}`),
      })).filter((x) => x.cost > 0.005).sort((a, b) => b.cost - a.cost);
      return res.json({ ok: true, output: JSON.stringify({ date, cacheStatus: r?.cacheStatus?.status ?? null, sessions: rows.length, total: Math.round(rows.reduce((t, x) => t + x.cost, 0) * 100) / 100, top: rows.slice(0, 30) }) + "\n" });
    }
    if (cmd === "meter.state") {
      return res.json({ ok: true, output: JSON.stringify(meter.state(), null, 2) + "\n" });
    }
    if (cmd === "report.daily.preview" || cmd === "report.daily.send") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
      const r = await meter.dailyReport(date);
      const sent = cmd === "report.daily.send" ? await meter.deliver("daily-manual", r.text) : null;
      return res.json({ ok: true, output: JSON.stringify({ date, text: r.text, sent, orCheck: r.orCheck, railway: r.railway }, null, 2) + "\n" });
    }
    if (cmd === "report.weekly.preview" || cmd === "report.weekly.send") {
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
      const r = await meter.weeklyReport(endDate);
      let sent = null;
      if (cmd === "report.weekly.send") {
        sent = await meter.deliver("weekly-manual", r.text);
        if (r.current.length) meter.saveModelsSnapshot(r.current);
      }
      return res.json({ ok: true, output: JSON.stringify({ endDate, text: r.text, sent, modelsListed: r.current.length }, null, 2) + "\n" });
    }
    if (cmd === "privacy.check") {
      // D6: can every seat model be served by a provider that does not collect data?
      // Two tiny requests per model (≈16 output tokens each): default routing vs data_collection "deny".
      let lineup = null;
      try { lineup = JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIR, "reports", "lineup.json"), "utf8")); } catch {}
      let cfgNow = {};
      try { cfgNow = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch {}
      const seatRefs = [lineup?.jarvis, ...(lineup?.jarvis?.fallbacks ?? []).map((m) => ({ model: m })), ...(lineup?.forum ?? []), ...(lineup?.counsel ?? []), ...(lineup?.research ?? [])]
        .map((x) => x?.model).filter(Boolean);
      const models = Array.from(new Set(seatRefs));
      const results = [];
      for (const ref of models) {
        const id = ref.replace(/^openrouter\//, "");
        const pinned = cfgNow.agents?.defaults?.models?.[ref]?.params?.provider ?? {};
        const row = { model: id };
        for (const [label, provider] of [["default", { ...pinned }], ["deny", { ...pinned, data_collection: "deny" }]]) {
          try {
            const body = { model: id, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16, usage: { include: true } };
            if (Object.keys(provider).length) body.provider = provider;
            const r = await safety.openRouterRequest("/chat/completions", { method: "POST", body });
            row[label] = r.ok
              ? { ok: true, provider: r.json?.provider ?? null, cost: r.json?.usage?.cost ?? null }
              : { ok: false, status: r.status, error: String(r.json?.error?.message ?? "").slice(0, 200) };
          } catch (err) {
            row[label] = { ok: false, error: String(err).slice(0, 160) };
          }
        }
        results.push(row);
      }
      return res.json({ ok: true, output: JSON.stringify(results, null, 2) + "\n" });
    }
    if (cmd === "pins.reconcile") {
      const report = await reconcileSeatSessionPinsV1();
      return res.json({ ok: true, output: JSON.stringify(report ?? null, null, 2) + "\n" });
    }
    if (cmd === "test.cleanup") {
      // Remove commissioning test sessions (agent:<id>:explicit:claude-test-*) so they never
      // enter memory search. Their cost stays recorded in the worklog.
      const removed = [];
      const failed = [];
      const testSessionIds = new Set(); // R11: kept so the meter still counts their usage as tests
      for (const agentId of ["main", "forum-01", "forum-02", "forum-03", "counsel-01", "counsel-02", "counsel-03", "research-01", "research-02"]) {
        let data = null;
        try { data = await gatewayCallJson("sessions.list", { agentId, limit: 500 }, 60_000); } catch { continue; }
        const keys = new Set();
        const walk = (o, d = 0) => {
          if (!o || typeof o !== "object" || d > 6) return;
          if (typeof o.key === "string" && o.key.includes(":explicit:claude-test-")) {
            keys.add(o.key);
            if (typeof o.sessionId === "string" && o.sessionId) testSessionIds.add(o.sessionId);
          }
          for (const v of Object.values(o)) walk(v, d + 1);
        };
        walk(data);
        for (const key of keys) {
          try { await gatewayCallJson("sessions.delete", { key, agentId, deleteTranscript: true }, 60_000); removed.push(key); }
          catch (err) { failed.push({ key, error: String(err).slice(0, 160) }); }
        }
      }
      if (testSessionIds.size) {
        const ledgerPath = path.join(STATE_DIR, "meter-test-sessions.json");
        let ledger = { ids: [], days: [] };
        try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch {}
        ledger.ids = Array.from(new Set([...(ledger.ids || []), ...testSessionIds])).slice(-2000);
        try { fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 }); } catch {}
      }
      return res.json({ ok: failed.length === 0, output: JSON.stringify({ removed, failed, recordedTestSessionIds: testSessionIds.size }, null, 2) + "\n" });
    }
    if (cmd === "meter.testday") {
      // R11: mark a commissioning day — sessions outside the owner's own chats count as tests.
      const date = String(arg || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ ok: false, output: "usage: meter.testday YYYY-MM-DD\n" });
      const ledgerPath = path.join(STATE_DIR, "meter-test-sessions.json");
      let ledger = { ids: [], days: [] };
      try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch {}
      ledger.days = Array.from(new Set([...(ledger.days || []), date])).sort();
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
      return res.json({ ok: true, output: JSON.stringify({ days: ledger.days, ids: (ledger.ids || []).length }) + "\n" });
    }
    if (cmd === "seat.set") {
      // Operator path to set one seat's model (same config change as the owner's
      // `/config set agents.entries.<seat>.model=...`). Jarvis keeps its fallback list.
      let spec;
      try { spec = JSON.parse(arg || "{}"); } catch { return res.status(400).json({ ok: false, error: "arg must be JSON {seat, model}" }); }
      const seat = String(spec.seat || "");
      const model = String(spec.model || "");
      if (!/^(main|forum-0[1-3]|counsel-0[1-3]|research-0[12])$/.test(seat)) return res.status(400).json({ ok: false, error: "bad seat" });
      if (!/^openrouter\/[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model)) return res.status(400).json({ ok: false, error: "bad model (openrouter/<vendor>/<model>)" });
      let current = null;
      try { current = JSON.parse(fs.readFileSync(configPath(), "utf8")).agents?.entries?.[seat]?.model ?? null; } catch {}
      const pathKey = seat === "main" && current && typeof current === "object" ? `agents.entries.${seat}.model.primary` : `agents.entries.${seat}.model`;
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", pathKey, model]), { timeoutMs: 60_000 });
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: JSON.stringify({ seat, from: modelRefOf(current), to: model, path: pathKey, cli: redactSecrets(String(r.output || "")).slice(0, 400) }) + "\n" });
    }
    if (cmd === "research.test") {
      // One small dual research run through the production runner (Verifier + Scout via OpenRouter
      // server tools, then source and support checks). arg "off" = without privacy routing.
      const dir = path.join(STATE_DIR, "tmp");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const briefPath = path.join(dir, `research-test-${Date.now()}.json`);
      fs.writeFileSync(briefPath, JSON.stringify({
        question: "What are OpenRouter's current list prices (input and output, US$ per million tokens) for the model openai/gpt-6-sol, and on which provider(s) is it served?",
        jurisdiction: "global/public product pages",
        period: "current",
        definitions: "List price = OpenRouter's published per-token price, before discounts or caching.",
        comparison_scope: "OpenRouter's own model page or API first.",
        stakes: "commissioning test only (low)",
        freshness: "current",
        test: true, // R14: the meter leaves this run out of the owner's spend
        exclusions: ["No recommendation.", "No private or logged-in pages."],
      }, null, 2), { mode: 0o600 });
      const t0 = Date.now();
      const r = await runCmd(OPENCLAW_NODE, [path.join(process.cwd(), "src", "jarvis-research-runner.js"), "run", briefPath, "dual"], {
        timeoutMs: 16 * 60 * 1000,
        extraEnv: { JARVIS_PRIVACY_ROUTING: arg === "off" ? "off" : "deny" },
      });
      try { fs.unlinkSync(briefPath); } catch {}
      const parsed = parseJsonFromOutput(r.output);
      const sm = parsed?.summary;
      return res.json({ ok: r.code === 0, output: JSON.stringify(sm ? {
        wallMs: Date.now() - t0, pass: sm.pass, partial: sm.partial ?? null, failures: sm.failures, check_errors: sm.check_errors ?? [], total_cost_usd: sm.total_cost_usd, failed_attempt_cost_usd: sm.failed_attempt_cost_usd ?? 0,
        telemetry: (sm.telemetry || []).map((x) => ({ researcher: x.researcher, model: x.model, provider: x.provider, search_engine: x.search_engine, search_requests: x.search_requests, attempts: x.attempts ?? 1, cost: x.usage?.cost })),
        merge: sm.merge, verification: sm.verification, semantic_support: sm.semantic_support,
      } : { code: r.code, head: redactSecrets(String(r.output || "")).slice(0, 1500) }, null, 2) + "\n" });
    }
    if (cmd === "research.runs") {
      // R12: the last research runs (numbers only — no brief text, no findings): pass, failures,
      // cost per researcher, attempts, searches and tokens. arg = how many (default 10, max 30).
      const n = Math.max(1, Math.min(30, Number.parseInt(arg || "10", 10) || 10));
      const p = researchPaths();
      let files = [];
      try { files = fs.readdirSync(p.runs).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: fs.statSync(path.join(p.runs, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, n); } catch {}
      const runs = files.map(({ f }) => {
        let s = null;
        try { s = JSON.parse(fs.readFileSync(path.join(p.runs, f), "utf8")); } catch { return { file: f, unreadable: true }; }
        const secs = (Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000;
        return {
          at: s.started_at, secs: Number.isFinite(secs) ? Math.round(secs) : null, level: s.level, gap: Boolean(s.ledger_brief_id),
          pass: s.pass, partial: s.partial ?? null, failures: (s.failures || []).map((x) => String(x).slice(0, 240)),
          checkErrors: (s.check_errors || []).map((x) => String(x).slice(0, 240)),
          cost: Math.round(Number(s.total_cost_usd || 0) * 1000) / 1000, failedAttemptCost: s.failed_attempt_cost_usd ?? null,
          support: s.semantic_support ? { cost: s.semantic_support.cost_usd ?? null, model: s.semantic_support.model ?? null } : null,
          researchers: (s.telemetry || []).map((x) => ({
            who: x.researcher, model: x.model, provider: x.provider, attempts: x.attempts ?? 1,
            searches: x.search_requests, tools: x.tool_calls_executed, cost: x.usage?.cost ?? null,
            inTok: x.usage?.prompt_tokens ?? null, cachedTok: x.usage?.prompt_tokens_details?.cached_tokens ?? null, outTok: x.usage?.completion_tokens ?? null,
          })),
        };
      });
      let retries = 0;
      let events = [];
      try {
        const lines = fs.readFileSync(p.events, "utf8").split("\n").filter(Boolean).slice(-4000);
        retries = lines.filter((l) => l.includes('"research-call-retry"')).length;
        // Timeline of the last events: names, times, ids and numbers only.
        events = lines.slice(-(n * 6)).map((l) => {
          try {
            const e = JSON.parse(l);
            return { at: e.at, event: e.event, brief: String(e.brief_id || e.parent_brief_id || "").slice(-12) || undefined, level: e.level ?? e.route, pass: e.pass, cost: e.total_cost_usd ?? e.cost_usd, who: e.researcher ?? e.requested_by ?? undefined, error: e.error ? String(e.error).slice(0, 160) : undefined };
          } catch { return null; }
        }).filter(Boolean);
      } catch {}
      return res.json({ ok: true, output: JSON.stringify({ runs, recentRetryEvents: retries, events }, null, 2) + "\n" });
    }
    if (cmd === "disk.usage") {
      const r = await runCmd("bash", ["-c", "df -h / /data 2>/dev/null; echo; du -xh -d 3 /data 2>/dev/null | sort -h | tail -45"], { timeoutMs: 180_000 });
      return res.json({ ok: r.code === 0, output: redactSecrets(String(r.output || "")).slice(0, 20_000) });
    }
    if (cmd === "openclaw.gateway.call") {
      // Narrow gateway RPC access for diagnostics. Reads only, plus clearing a session model pin.
      let spec;
      try { spec = JSON.parse(arg || "{}"); } catch { return res.status(400).json({ ok: false, error: "arg must be JSON {method, params}" }); }
      const method = String(spec.method || "");
      const params = spec.params && typeof spec.params === "object" ? spec.params : {};
      const READ = new Set(["sessions.get", "sessions.list", "sessions.describe", "sessions.usage", "sessions.usage.logs", "sessions.usage.timeseries", "channels.status", "health", "status", "cron.list", "models.list", "tasks.list", "usage.cost"]);
      const pinClear = method === "sessions.patch" && typeof params.key === "string"
        && Object.keys(params).every((k) => ["key", "model", "thinkingLevel"].includes(k))
        && (params.model === undefined || params.model === null)
        && (params.thinkingLevel === undefined || params.thinkingLevel === null);
      if (!READ.has(method) && !pinClear) return res.status(400).json({ ok: false, error: "method not allowed" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", "30000"]), { timeoutMs: 45_000 });
      const out = redactSecrets(r.output || "");
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: out.length > 60_000 ? out.slice(0, 60_000) + "\n...(truncated)" : out });
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
    // R8: wait until it is really gone (it otherwise drains for minutes).
    try {
      gatewayLifecycleBusy = true;
      await stopGatewayProc({ hardAfterMs: 15_000 });
    } catch {
      // ignore
    } finally {
      gatewayLifecycleBusy = false;
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

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Stop gateway before restore so we don't overwrite live files. R8: wait until it is really
    // gone (the old SIGTERM + 750 ms left it draining while files were overwritten), and keep the
    // watchdog and the proxy from starting it again until the files are in place.
    restoreInProgress = true;
    gatewayLifecycleBusy = true;
    try {
      await stopGatewayProc({ hardAfterMs: 15_000 });

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
    } finally {
      restoreInProgress = false;
      gatewayLifecycleBusy = false;
    }

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

    // Config undo: keep a timestamped copy of the config as it was before this boot's
    // reconciliation (last 30 kept). Restore = POST the chosen copy to /setup/api/config/raw.
    try {
      const backupDir = path.join(STATE_DIR, "config-backups");
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(path.join(backupDir, `openclaw-${stamp}.json`), raw, { encoding: "utf8", mode: 0o600 });
      const copies = fs.readdirSync(backupDir).filter((f) => /^openclaw-.*\.json$/.test(f)).sort();
      for (const old of copies.slice(0, Math.max(0, copies.length - 30))) {
        try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
      }
      console.log(`[config-backup-v1] saved openclaw-${stamp}.json (kept ${Math.min(copies.length, 30)})`);
    } catch (err) {
      console.warn(`[config-backup-v1] failed: ${String(err)}`);
    }

    // Memory embeddings authenticate through the provider entry's auth-profile binding
    // (apiKey "openrouter:default" = use the openrouter:default auth profile; see OpenClaw
    // openai-compatible-embedding-provider.ts). R1 removed it by mistake and memory sync
    // failed with 401; keep it bound. Chat models use the same profile either way.
    const orProvider = cfg.models?.providers?.openrouter;
    if (orProvider && !orProvider.apiKey) {
      orProvider.apiKey = "openrouter:default";
      console.log("[wrapper] restored OpenRouter provider auth-profile binding (memory embeddings)");
    }

    // D6 privacy (2026-09-26): every OpenRouter chat request may only use providers that do not
    // collect data. Checked live first (privacy.check): all seat models are served under this
    // rule; only the Scout's provider changes (DeepSeek: StreamLake → Sail Research). Per-model
    // routing (e.g. MiMo pinned to Xiaomi) merges on top. JARVIS_PRIVACY_ROUTING=off disables it.
    if (orProvider) {
      orProvider.params ??= {};
      const routing = { ...(orProvider.params.provider && typeof orProvider.params.provider === "object" ? orProvider.params.provider : {}) };
      if (process.env.JARVIS_PRIVACY_ROUTING?.trim() === "off") delete routing.data_collection;
      else routing.data_collection = "deny";
      if (Object.keys(routing).length) orProvider.params.provider = routing; else delete orProvider.params.provider;
      if (Object.keys(orProvider.params).length === 0) delete orProvider.params;
      console.log("[privacy-routing-v1] " + JSON.stringify({ dataCollection: routing.data_collection ?? "provider-default" }));
    }

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
    // R9: Code Mode waits hold up to 60 s (default 10 s). Each wait that returns "still waiting"
    // costs a full model call; while research or seats ran, Jarvis re-checked every ~10 s and
    // each check re-sent its whole working context (26 Sep: ~$0.13 a check, ~150 checks).
    // Activation is unchanged: "auto" globally, on for Jarvis, off for seats (set below).
    {
      const cm = cfg.tools.codeMode;
      const enabled = cm === undefined ? "auto" : (typeof cm === "object" && cm !== null ? (cm.enabled ?? false) : cm);
      cfg.tools.codeMode = { ...(typeof cm === "object" && cm !== null ? cm : {}), enabled, timeoutMs: 60_000 };
    }
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
      // D2 / research design (2026-09-26): researchers do all browsing; Jarvis has no browser
      // and no gateway (config/restart) control. Messaging, orchestration, memory and Lobster stay.
      mainEntry.tools.alsoAllow = Array.from(new Set([
        ...(Array.isArray(mainEntry.tools.alsoAllow) ? mainEntry.tools.alsoAllow : []).filter((t) => t !== "browser" && t !== "gateway"),
        "group:messaging",
        "lobster",
      ]));
      mainEntry.tools.deny = Array.from(new Set([
        ...(Array.isArray(mainEntry.tools.deny) ? mainEntry.tools.deny : []),
        "browser",
        "gateway",
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
    // B7: whole-run ceiling 90 min; each model request may run up to 20 min (Counsel at max
    // thinking). Per-room wait budgets live in the room policy (Forum 8, Counsel 20, research 10/30).
    cfg.agents.defaults.timeoutSeconds = 5400;
    if (cfg.models?.providers?.openrouter) cfg.models.providers.openrouter.timeoutSeconds = 1200;
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

    // Code Mode (tool schemas deferred behind exec/wait, small prompt) is an agent-level
    // choice for Jarvis only (set below). A model-level flag would also switch it on for
    // any seat or researcher that runs the same model — e.g. the Verifier runs GPT-6 Sol
    // like Jarvis, and Forum 1 runs Grok — whose tool policy denies "exec", the name of
    // Code Mode's control tool. So model-level flags are removed here.
    for (const modelCfg of Object.values(cfg.agents.defaults.models ?? {})) {
      if (modelCfg && typeof modelCfg === "object" && "codeMode" in modelCfg) delete modelCfg.codeMode;
    }

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
    applyJarvisSeatConfigV1({ cfg, stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR });
    // Keep Jarvis's prompt small on any model: defer full tool schemas behind Code Mode.
    // Code Mode: on for Jarvis whatever model it runs (fallback included); explicitly off for
    // seats and researchers, which need their few tools directly.
    if (cfg.agents?.entries?.main) {
      cfg.agents.entries.main.tools ??= {};
      cfg.agents.entries.main.tools.codeMode = true;
    }
    for (const id of ["forum-01", "forum-02", "forum-03", "counsel-01", "counsel-02", "counsel-03", "research-01", "research-02"]) {
      const entry = cfg.agents?.entries?.[id];
      if (!entry) continue;
      entry.tools ??= {};
      entry.tools.codeMode = false;
    }

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

    // D3 owner-only: strangers get no reply (not even a pairing code) and never reach a
    // model. DMs are admitted only from the owner's own WhatsApp number and Telegram
    // account. Groups stay owner-authorized via groupAllowFrom (see whatsapp-rooms-v1).
    cfg.channels ??= {};
    cfg.channels.whatsapp ??= {};
    cfg.channels.whatsapp.enabled = true;
    const ownerWa = process.env.JARVIS_WHATSAPP_OWNER_E164?.trim()
      || (Array.isArray(cfg.channels.whatsapp.groupAllowFrom) ? cfg.channels.whatsapp.groupAllowFrom[0] : "");
    cfg.commands ??= {};
    const ownerCmd = Array.isArray(cfg.commands.ownerAllowFrom) ? cfg.commands.ownerAllowFrom : [];
    const ownerTelegramIds = ownerCmd
      .filter((e) => typeof e === "string" && e.startsWith("telegram:"))
      .map((e) => e.slice("telegram:".length))
      .filter((id) => /^\d+$/.test(id));
    if (ownerWa) {
      cfg.channels.whatsapp.dmPolicy = "allowlist";
      cfg.channels.whatsapp.allowFrom = Array.from(new Set([ownerWa]));
      cfg.commands.ownerAllowFrom = Array.from(new Set([...ownerCmd, `whatsapp:${ownerWa}`]));
    } else {
      cfg.channels.whatsapp.dmPolicy = "pairing";
      console.warn("[owner-only-v1] WhatsApp owner number unknown; leaving pairing mode");
    }
    if (cfg.channels.telegram && ownerTelegramIds.length > 0) {
      cfg.channels.telegram.dmPolicy = "allowlist";
      cfg.channels.telegram.allowFrom = Array.from(new Set(ownerTelegramIds));
    }
    console.log("[owner-only-v1] " + JSON.stringify({
      whatsappDm: cfg.channels.whatsapp.dmPolicy,
      whatsappAllow: (cfg.channels.whatsapp.allowFrom || []).length,
      telegramDm: cfg.channels.telegram?.dmPolicy ?? null,
      telegramAllow: (cfg.channels.telegram?.allowFrom || []).length,
      ownerCommandSurfaces: (cfg.commands.ownerAllowFrom || []).map((e) => String(e).split(":")[0]),
    }));

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
          "- Forum 'everyone': at most three independent adviser calls. Synthesis (by Jarvis unless the owner names another) and any second round happen ONLY on the owner's explicit command — never automatically. No research for greetings/check-ins.",
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
          "- Forum 'everyone': at most three independent adviser calls. Add one separate synthesis call only when synthesis is requested, using the model/seat selected for that run; no numbered seat has permanent synthesis authority. No research for greetings/check-ins. A second adviser round requires a material contradiction/gap or an explicit owner request.",
          "- The standard model request envelope is 32k. Treat it as an admission/reasoning envelope, not a spend throttle; actual usage is metered from generated tokens.",
          "- Large artifacts should normally be written coherently in sections/files. Raise the per-job ceiling above 32k only when the requested deliverable genuinely benefits from one-shot generation; never restore 128k+ as the global default.",
          "- Background learning/review is off. Use Skill Workshop only on explicit owner request.",
        ];
        const newPolicyLines = [
          "- Forum 'everyone': at most three independent adviser calls. Synthesis (by Jarvis unless the owner names another) and any second round happen ONLY on the owner's explicit command — never automatically. No research for greetings/check-ins.",
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

    // Jarvis answering policy (managed block in AGENTS.md).
    try {
      const agentsPath = path.join(WORKSPACE_DIR, "AGENTS.md");
      if (fs.existsSync(agentsPath)) {
        const begin = "<!-- jarvis-answering-policy-v1:begin -->";
        const finish = "<!-- jarvis-answering-policy-v1:end -->";
        const block = [
          begin,
          "## Jarvis Answering Policy v1",
          "",
          "- Plain chat: answer directly and briefly. No research or rooms for greetings, check-ins or simple questions — unless the owner invokes a room (next point).",
          "- Rooms: a message that starts with \"Forum:\" or \"Counsel:\" (or asks for Forum or Counsel by name) is the owner's explicit room command, on any channel. \"Counsel:\" means RUN THE COUNSEL ROOM — it never means \"give me your own advice\". Read the jarvis-rooms skill and run that room's full protocol, even when the question is simple or asks for short answers (those instructions are for the seats' answers). Never answer such a message yourself unless the owner says so.",
          "- If you are not sure of a fact, say so plainly instead of guessing. Check current facts (prices, news, who holds a role, rules) through research before stating them.",
          "- Web research is done by the research runner (`node /app/src/jarvis-research-runner.js`, see the jarvis-rooms skill), not by Jarvis browsing and never by spawning research-01 or research-02.",
          "- Seat models are changed only by the owner, never by you. When he asks to switch a seat (e.g. \"put Opus 7 in Counsel 1\"), reply with the exact command for him to send: for Jarvis `/model <provider/model> -a` (keeps Jarvis's fallback); for a seat `/config set agents.entries.<seat-id>.model=<provider/model>` with seat ids forum-01, forum-02, forum-03, counsel-01, counsel-02, counsel-03, research-01 (Verifier), research-02 (Scout). Check the current lineup in /data/workspace/reports/lineup.json and warn if the switch puts two models from the same company in one room.",
          "- Meter: when the owner says \"meter\" (or asks what Salem AI cost today or yesterday), read /data/workspace/reports/meter-latest.md and send its two blocks as they are. The numbers come from the wrapper's meter; never recompute or estimate them. If the file is missing or its Updated time is more than 3 hours old, say so.",
          "- If you are running on your fallback model (a \"Model Fallback\" notice appeared, or your runtime model is not Jarvis's model in lineup.json), keep helping, but in Forum and Counsel act as clerk only (no view of your own, no synthesis) and tell the owner that Jarvis's primary model is unavailable.",
          finish,
        ].join("\n");
        let text = fs.readFileSync(agentsPath, "utf8");
        const a = text.indexOf(begin);
        const b = text.indexOf(finish);
        const next = a >= 0 && b > a ? text.slice(0, a) + block + text.slice(b + finish.length) : text.trimEnd() + "\n\n" + block + "\n";
        if (next !== text) fs.writeFileSync(agentsPath, next, { encoding: "utf8", mode: 0o600 });
      }
    } catch (err) {
      console.warn(`[answering-policy-v1] failed: ${String(err)}`);
    }

    // Seat-side copy of the owner's room protocol (2026-09-26), so every seat follows the same
    // rules Jarvis runs (older seat rules mentioned automatic second passes).
    try {
      const begin = "<!-- salem-room-protocol-v1:begin -->";
      const finish = "<!-- salem-room-protocol-v1:end -->";
      const common = [
        "- Give your own first answer independently. You never see other seats' answers before yours.",
        "- A second pass happens only when Jarvis relays the owner's explicit command (for example \"debate\" or \"second round\"). Never start one yourself.",
        "- Synthesize only when you are named as the synthesizer for this run; otherwise never merge the other seats' views.",
        "- If evidence is missing, start your answer with `RESEARCH NEEDED: <question>` and continue with clearly marked assumptions. The research agents do the searching, not you.",
        "- Say plainly when you are unsure.",
      ];
      const counselExtra = [
        "- Counsel order: the research pack comes first; you may ask for more research (RESEARCH NEEDED); then your blind first answer. Afterwards Jarvis may send you the Forum answers, the Forum synthesis and all Counsel first answers — use them only for a second round the owner ordered.",
      ];
      for (const id of ["forum-01", "forum-02", "forum-03", "counsel-01", "counsel-02", "counsel-03"]) {
        const entry = cfg.agents?.entries?.[id];
        if (!entry) continue;
        const dir = entry.workspace || path.join("/data/agent-workspaces", id);
        const file = path.join(dir, "AGENTS.md");
        if (!fs.existsSync(dir)) continue;
        const block = [
          begin,
          "## Owner's room protocol (2026-09-26) — this overrides older rules in this file",
          "",
          ...common,
          ...(id.startsWith("counsel-") ? counselExtra : []),
          finish,
        ].join("\n");
        let text = "";
        try { text = fs.readFileSync(file, "utf8"); } catch {}
        const a = text.indexOf(begin);
        const b = text.indexOf(finish);
        const next = a >= 0 && b > a ? text.slice(0, a) + block + text.slice(b + finish.length) : (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + block + "\n";
        if (next !== text) fs.writeFileSync(file, next, { encoding: "utf8", mode: 0o600 });
      }
    } catch (err) {
      console.warn(`[room-protocol-seat-v1] failed: ${String(err)}`);
    }

    // G1 finding (2026-09-26): research runs only through the research runner (search engine,
    // tool budgets and time limits built in). Jarvis may not spawn the researcher agents
    // directly — that path has no search provider and cost ~40x more in the Counsel test.
    {
      const mainSub = cfg.agents?.entries?.main?.subagents;
      if (mainSub && Array.isArray(mainSub.allowAgents)) {
        const before = mainSub.allowAgents.length;
        mainSub.allowAgents = mainSub.allowAgents.filter((id) => id !== "research-01" && id !== "research-02");
        if (mainSub.allowAgents.length !== before) console.log("[research-path-v1] Jarvis spawns seats only; research goes through the runner");
      }
    }

    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log("[wrapper] Jarvis operational defaults + non-revenue-token controls applied");
  } catch (err) {
    console.warn(`[wrapper] failed to apply Jarvis operational defaults: ${String(err)}`);
  }
}

// B2 gateway watchdog: restart a crashed or frozen gateway (max 3 per hour), then escalate.
// R8: stays out of deliberate stops/restarts and boot starts, stands by while another copy of
// the wrapper runs Jarvis, treats a running-but-untracked gateway as running, and only reports
// "restarted" when the restart worked. A crash test restarts silently and uncounted.
async function gatewayWatchdogTick() {
  const bootOwnsStart = bootStartPending && Date.now() - WRAPPER_STARTED_AT < 15 * 60 * 1000;
  if (watchdogBusy || gatewayLifecycleBusy || restoreInProgress || bootOwnsStart || !isConfigured() || gatewayStarting) return;
  if (safety.isLatched()) { watchdogFailures = 0; return; }
  if (isStandby()) { watchdogFailures = 0; return; }
  if (Date.now() - WRAPPER_STARTED_AT < 3 * 60 * 1000) return; // boot grace (boot retry timer owns this window)
  watchdogBusy = true;
  try {
    let reason = null;
    const untracked = gatewayProc ? [] : strayGatewayPids();
    if (!gatewayProc && untracked.length === 0) {
      reason = "had stopped unexpectedly";
    } else if (await gatewayResponds(8_000)) {
      if (untracked.length && !untrackedLogged) {
        untrackedLogged = true;
        console.warn(`[watchdog-v1] gateway is running but untracked (pid ${untracked.join(", ")}); it keeps running, and stops still reach it`);
      }
      watchdogFailures = 0;
      return;
    } else {
      watchdogFailures += 1;
      console.warn(`[watchdog-v1] gateway not responding (${watchdogFailures}/3)`);
      if (watchdogFailures < 3) return;
      reason = "was frozen for about 3 minutes";
    }
    const isTest = watchdogTest;
    watchdogTest = false;
    if (!isTest) {
      const budget = safety.restartBudget();
      if (budget.remaining <= 0) {
        await safety.sendAlert("watchdog-escalation", `Jarvis ${reason} and has already been restarted 3 times in the last hour. Automatic restarts are paused — needs attention.`, { dedupeMs: 60 * 60 * 1000 });
        return;
      }
    }
    const n = isTest ? 0 : safety.recordRestart();
    console.warn(`[watchdog-v1] gateway ${reason} — restarting${isTest ? " (test)" : ` (${n}/3 this hour)`}`);
    let restarted = false;
    gatewayLifecycleBusy = true;
    try {
      await stopGatewayProc({ hardAfterMs: 10_000 });
      await ensureGatewayRunning({ attempts: 3, retryDelayMs: 10_000 });
      restarted = true;
    } catch (err) {
      console.warn(`[watchdog-v1] restart failed: ${String(err)}`);
    } finally {
      gatewayLifecycleBusy = false;
    }
    watchdogFailures = 0;
    if (isTest) {
      console.log(`[watchdog-v1] test restart ${restarted ? "OK" : "FAILED"} (no owner alert for tests)`);
      return;
    }
    if (restarted) {
      await safety.sendAlert("watchdog-restart", `Jarvis ${reason} and was restarted automatically (${n}/3 this hour).`);
    }
  } finally {
    watchdogBusy = false;
  }
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  // R8: the boot start owns bringing Jarvis up (the watchdog stays out until it is done).
  if (isConfigured() && !safety.isLatched()) bootStartPending = true;
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

  // B2: independent in-container watchdog for a hung wrapper (kills it so Railway restarts us).
  try {
    const wdPath = new URL("./wrapper-watchdog.js", import.meta.url).pathname;
    const wd = childProcess.spawn(process.execPath, [wdPath], {
      stdio: "inherit",
      env: childEnv({ WATCHDOG_WRAPPER_PID: String(process.pid), WATCHDOG_PORT: String(PORT) }),
    });
    wd.on("exit", (code) => console.warn(`[wrapper-watchdog-v1] exited code=${code}`));
  } catch (err) {
    console.warn(`[wrapper-watchdog-v1] failed to start: ${String(err)}`);
  }

  // R8: heartbeat for other copies of this wrapper on the same volume (every 15 s).
  peers.beat(Boolean(gatewayProc));
  setInterval(() => { peers.beat(Boolean(gatewayProc)); }, 15_000).unref?.();

  // B2 gateway watchdog (every 60 s) and B3 money fuse (every 5 min; first check after 1 min).
  // R8: a copy on standby (another copy runs Jarvis) does no fuse or meter work and sends nothing.
  setInterval(() => { void gatewayWatchdogTick(); }, 60_000).unref?.();
  const fuseRun = () => (isStandby() ? null : safety.fuseTick({
    stopGateway: async () => {
      gatewayLifecycleBusy = true;
      try { await stopGatewayProc({ hardAfterMs: 10_000 }); } finally { gatewayLifecycleBusy = false; }
    },
  }));
  setTimeout(() => { void fuseRun(); }, 60_000).unref?.();
  setInterval(() => { void fuseRun(); }, 5 * 60_000).unref?.();

  // C3/C4/G2 meter: container sample every 5 min, meter-latest.md hourly, daily report 07:00
  // Qatar (WhatsApp, Telegram fallback), weekly $/task report Sundays 07:05. First tick after 4 min.
  const meterRun = () => { if (!isStandby()) void meter.tick(); };
  setTimeout(() => {
    meterRun();
    setInterval(meterRun, 60_000).unref?.();
  }, 4 * 60_000).unref?.();

  // B5: a latched (deliberate) stop survives container restarts and redeploys.
  const bootLatch = safety.latchInfo();
  if (isConfigured() && bootLatch) {
    console.log("[latch-v1] gateway NOT started at boot: " + JSON.stringify(bootLatch));
    void safety.sendAlert("latched-boot", bootLatch.reason === "commissioning-test"
      ? "Restart test: Salem AI came back in STOPPED mode, as designed after a deliberate stop. Claude restarts Jarvis within minutes — no action needed."
      : `Salem AI restarted, but Jarvis stays STOPPED (reason: ${bootLatch.reason}). Start it from /setup → gateway.start when ready.`, { dedupeMs: 6 * 60 * 60 * 1000 });
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured() && !bootLatch) {
    console.log("[wrapper] config detected; starting gateway...");
    void startGatewayAtBoot();
  } else {
    bootStartPending = false;
  }
});

// Boot start. Railway can briefly overlap old/new containers on the same persistent volume, and a
// failed release can leave its container running for minutes. R8: while another copy runs Jarvis
// this copy waits (standby) instead of starting a second gateway; then it starts with retries
// (OpenClaw's lock can outlive the old container briefly). The watchdog stays out until this is
// done; if Jarvis is still not up after 10 minutes the owner gets one alert.
async function startGatewayAtBoot() {
  bootStartPending = true;
  const bootAt = Date.now();
  let alerted = false;
  let waitingLogged = false;
  try {
    for (;;) {
      if (safety.isLatched()) { console.log("[wrapper] boot start skipped: stopped by owner"); return; }
      if (gatewayProc) break;
      const sb = peers.status(false);
      if (sb.standby) {
        if (!waitingLogged) { waitingLogged = true; console.log(`[wrapper] waiting to start Jarvis: ${sb.reason}`); }
        await sleep(10_000);
        continue;
      }
      try {
        await ensureGatewayRunning({ attempts: 3, retryDelayMs: 10_000 });
        break;
      } catch (err) {
        console.warn(`[wrapper] gateway not started yet: ${String(err)}`);
        if (!alerted && Date.now() - bootAt > 10 * 60 * 1000) {
          alerted = true;
          await safety.sendAlert("boot-start-failed", "Salem AI restarted, but Jarvis has not come back after 10 minutes. It keeps retrying — needs attention if this persists.", { dedupeMs: 6 * 60 * 60 * 1000 });
        }
        await sleep(30_000);
      }
    }
    console.log("[wrapper] gateway ready");
    await runJarvisMainSessionRecoveryV1();
    void reconcileSeatSessionPinsV1().catch((err) => console.warn(`[seat-pins-v3] failed: ${String(err)}`));
    launchOpenRouterKeyAuditV1();
    launchJarvisSecurityAuditV1();
    launchJarvisAgentSmokeV1();
    launchJarvisAdviserMemoryCommissioningV1();
  } catch (err) {
    console.error(`[wrapper] boot start error: ${String(err)}`);
  } finally {
    bootStartPending = false;
  }
}

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

  // R8: tell other copies we are leaving (a new container can start Jarvis at once), and make
  // sure our gateway is really gone (hard stop after 6 s) so its lock is released promptly.
  peers.markStopping();
  gatewayLifecycleBusy = true;
  try {
    await stopGatewayProc({ hardAfterMs: 6_000 });
  } catch {}

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
