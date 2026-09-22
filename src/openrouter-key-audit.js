import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function findKeys({ stateDir, configPath }) {
  const sources = [];
  const seen = new Set();
  const add = (entry) => {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    sources.push({ ...entry, key });
  };

  // Scan only canonical provider-auth stores; never inspect transcripts or
  // workspaces for secrets. v2026.9.x stores auth profiles in SQLite, while
  // older installations may still retain JSON migration sources.
  const agentsRoot = path.join(stateDir, "agents");

  const scanProfileStore = (store, source, agentId) => {
    if (!store?.profiles || typeof store.profiles !== "object") return;
    for (const [profileId, profile] of Object.entries(store.profiles)) {
      if (profile?.provider !== "openrouter") continue;
      if (typeof profile.key === "string") {
        add({ source, agentId, profileId, key: profile.key });
      }
    }
  };

  const scanSqlite = (dbPath, source, agentId) => {
    if (!fs.existsSync(dbPath)) return;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('auth_profile_store','auth_profile_stores')"
      ).all();
      for (const row of tables) {
        const table = String(row.name);
        let rows = [];
        try { rows = db.prepare(`SELECT store_json FROM ${table}`).all(); } catch { continue; }
        for (const value of rows) {
          if (typeof value?.store_json !== "string") continue;
          let store;
          try { store = JSON.parse(value.store_json); } catch { continue; }
          scanProfileStore(store, source + ":" + table, agentId);
        }
      }
    } catch {
      // Diagnostic is best-effort and read-only.
    } finally {
      try { db?.close(); } catch {}
    }
  };

  try {
    for (const agentId of fs.readdirSync(agentsRoot)) {
      const agentDir = path.join(agentsRoot, agentId, "agent");

      const authPath = path.join(agentDir, "auth-profiles.json");
      const auth = readJson(authPath);
      if (auth) {
        scanProfileStore(auth, "agent-auth-profile-json", agentId);

        // Older flat shape, migration source only.
        const flat = auth.openrouter;
        if (flat && typeof flat === "object") {
          const flatKey = typeof flat.apiKey === "string" ? flat.apiKey : flat.key;
          if (typeof flatKey === "string") {
            add({ source: "agent-auth-legacy-flat", agentId, profileId: null, key: flatKey });
          }
        }
      }

      scanSqlite(path.join(agentDir, "openclaw-agent.sqlite"), "agent-auth-sqlite", agentId);
    }
  } catch {}

  // Shared auth profiles live here on current OpenClaw; older migrated installs
  // may still keep the shared row in main's agent DB, already covered above.
  scanSqlite(path.join(stateDir, "state", "openclaw.sqlite"), "shared-auth-sqlite", null);

  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) add({ source: "process-env", agentId: null, profileId: null, key: envKey });

  const cfg = readJson(configPath);
  const cfgKey = cfg?.env?.vars?.OPENROUTER_API_KEY;
  if (typeof cfgKey === "string") {
    add({ source: "config-env", agentId: null, profileId: null, key: cfgKey });
  }
  const providerKey = cfg?.models?.providers?.openrouter?.apiKey;
  if (typeof providerKey === "string" && !providerKey.startsWith("${")) {
    add({ source: "config-provider", agentId: null, profileId: null, key: providerKey });
  }

  return sources;
}


async function resolveOpenRouterKeyViaGateway(configPath) {
  const cfg = readJson(configPath);
  if (!cfg) return null;

  let mod;
  try {
    mod = await import("file:///openclaw/dist/cli/command-secret-gateway.js");
  } catch {
    return null;
  }

  // Wrapper readiness can precede publication of the active secret snapshot by
  // a few seconds. Retry only this read-only resolution path, with a hard bound.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const resolved = await mod.resolveCommandSecretRefsViaGateway({
        config: cfg,
        commandName: "openrouter key metadata audit",
        targetIds: new Set(["models.providers.*.apiKey"]),
        allowedPaths: new Set(["models.providers.openrouter.apiKey"]),
        forcedActivePaths: new Set(["models.providers.openrouter.apiKey"]),
        mode: "enforce_resolved",
        allowLocalExecSecretRefs: false,
        gatewaySecretResolveTimeoutMs: 15_000,
      });
      const key = resolved?.resolvedConfig?.models?.providers?.openrouter?.apiKey;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // Bounded retry below; never log the secret or resolver payload.
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return null;
}

function pickData(data) {
  if (!data || typeof data !== "object") return null;
  const keys = [
    "label", "name", "limit", "limit_remaining", "limit_reset",
    "usage", "usage_daily", "usage_weekly", "usage_monthly",
    "is_free_tier", "rate_limit",
  ];
  const out = {};
  for (const k of keys) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

export async function runOpenRouterKeyAuditV1({ stateDir, configPath, workspaceDir }) {
  if (process.env.JARVIS_OPENROUTER_KEY_AUDIT_V1?.trim() !== "1") {
    return { ran: false, reason: "disabled" };
  }

  const dir = path.join(workspaceDir, "diagnostics");
  const resultPath = path.join(dir, "openrouter-key-audit-v1.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const found = findKeys({ stateDir, configPath });
  const gatewayResolvedKey = await resolveOpenRouterKeyViaGateway(configPath);
  if (gatewayResolvedKey && !found.some((item) => item.key === gatewayResolvedKey)) {
    found.unshift({
      source: "gateway-secrets-resolve",
      agentId: null,
      profileId: null,
      key: gatewayResolvedKey,
    });
  }

  let result;
  if (!found.length) {
    result = { ok: false, reason: "openrouter-key-not-resolved", candidates: 0 };
  } else {
    const candidates = [];
    for (const item of found) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/key", {
          method: "GET",
          headers: { Authorization: `Bearer ${item.key}` },
        });
        let body = null;
        try { body = await res.json(); } catch {}
        const data = body?.data ?? body;
        candidates.push({
          ok: res.ok,
          httpStatus: res.status,
          source: item.source,
          agentId: item.agentId,
          profileId: item.profileId,
          metadata: pickData(data),
          error: res.ok ? null : (data?.error?.message || body?.error?.message || null),
        });
      } catch (err) {
        candidates.push({
          ok: false,
          source: item.source,
          agentId: item.agentId,
          profileId: item.profileId,
          error: String(err),
        });
      }
    }
    result = { ok: candidates.some((x) => x.ok), candidates };
  }

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(resultPath, 0o600); } catch {}
  console.log("[openrouter-key-audit-v1] completed " + JSON.stringify(result));
  return { ran: true, resultPath, ok: Boolean(result.ok) };
}
