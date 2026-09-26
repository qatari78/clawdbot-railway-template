import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function resolveSecretRefLocally(ref, stateDir) {
  if (!ref || typeof ref !== "object") return null;
  const source = String(ref.source || "");
  const id = typeof ref.id === "string" ? ref.id.trim() : "";
  if (!id) return null;

  if (source === "env") {
    const value = process.env[id];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  if (source === "store") {
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    if (!fs.existsSync(dbPath)) return null;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare(
        "SELECT value FROM secret_store_entries WHERE scope_kind='team' AND scope_id='' AND name=? AND deleted_at_ms IS NULL LIMIT 1"
      ).get(id);
      const value = row?.value;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  // File/exec refs deliberately stay outside this metadata diagnostic.
  return null;
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
      const refKey = resolveSecretRefLocally(profile?.keyRef, stateDir);
      if (refKey) {
        add({
          source: `${source}:keyRef:${String(profile.keyRef?.source || "unknown")}`,
          agentId,
          profileId,
          key: refKey,
        });
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


  // v13+ canonical shared auth profile store is folded into config_machine_state.
  const sharedDbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (fs.existsSync(sharedDbPath)) {
    let db;
    try {
      db = new DatabaseSync(sharedDbPath, { readOnly: true });
      const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (schemaVersion >= 13) {
        const row = db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store' LIMIT 1"
        ).get();
        if (typeof row?.value_json === "string") {
          try {
            scanProfileStore(JSON.parse(row.value_json), "shared-auth-config-machine-state", null);
          } catch {}
        }
      }
    } catch {
      // Best-effort read-only discovery.
    } finally {
      try { db?.close(); } catch {}
    }
  }

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
  // "openrouter:default" style values are auth-profile bindings (OpenClaw resolves them to the
  // profile's key at request time — memory embeddings depend on it), not literal keys.
  if (
    typeof providerKey === "string" &&
    !providerKey.startsWith("${") &&
    providerKey !== "secretref-managed" &&
    !/^[a-z0-9_-]+:[a-z0-9_.-]+$/i.test(providerKey)
  ) {
    add({ source: "config-provider", agentId: null, profileId: null, key: providerKey });
  }

  return sources;
}


async function resolveOpenRouterKeyViaGateway({
  runCmd,
  clawArgs,
  openclawNode,
  gatewayToken,
  gatewayPort,
}) {
  if (!gatewayToken) return null;

  const params = JSON.stringify({
    commandName: "openrouter key metadata audit",
    targetIds: ["models.providers.*.apiKey"],
    allowedPaths: ["models.providers.openrouter.apiKey"],
    forcedActivePaths: ["models.providers.openrouter.apiKey"],
  });

  // The wrapper can mark the Gateway ready a moment before its active SecretRef
  // snapshot is published. Retry only this read-only RPC with a hard bound.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const r = await runCmd(
      openclawNode,
      clawArgs([
        "gateway", "call", "secrets.resolve",
        "--port", String(gatewayPort),
        "--token", gatewayToken,
        "--params", params,
        "--timeout", "15000",
        "--json",
      ]),
      { timeoutMs: 20_000 },
    );

    if (r.code === 0) {
      const raw = String(r.output || "").trim();
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        const first = raw.indexOf("{");
        const last = raw.lastIndexOf("}");
        if (first >= 0 && last > first) {
          try { payload = JSON.parse(raw.slice(first, last + 1)); } catch {}
        }
      }

      const assignments = Array.isArray(payload?.assignments)
        ? payload.assignments
        : Array.isArray(payload?.result?.assignments)
          ? payload.result.assignments
          : [];
      for (const assignment of assignments) {
        const parts = Array.isArray(assignment?.pathSegments) ? assignment.pathSegments : [];
        if (
          parts.join(".") === "models.providers.openrouter.apiKey" &&
          typeof assignment?.value === "string" &&
          assignment.value.trim()
        ) {
          return assignment.value.trim();
        }
      }
    }

    if (attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  return null;
}


export async function resolveOpenRouterKeyForRuntime({ stateDir, configPath }) {
  const found = findKeys({ stateDir, configPath });
  const attempts = [];
  for (const item of found) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: { Authorization: `Bearer ${item.key}` },
      });
      attempts.push({
        ok: res.ok,
        httpStatus: res.status,
        source: item.source,
        agentId: item.agentId,
        profileId: item.profileId,
      });
      if (res.ok) {
        return {
          key: item.key,
          source: item.source,
          agentId: item.agentId,
          profileId: item.profileId,
          attempts,
        };
      }
    } catch {
      attempts.push({
        ok: false,
        httpStatus: null,
        source: item.source,
        agentId: item.agentId,
        profileId: item.profileId,
      });
    }
  }
  return { key: null, source: null, agentId: null, profileId: null, attempts };
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

export async function runOpenRouterKeyAuditV1({
  stateDir,
  configPath,
  workspaceDir,
  runCmd,
  clawArgs,
  openclawNode,
  gatewayToken,
  gatewayPort,
}) {
  if (process.env.JARVIS_OPENROUTER_KEY_AUDIT_V1?.trim() !== "1") {
    return { ran: false, reason: "disabled" };
  }

  const dir = path.join(workspaceDir, "diagnostics");
  const resultPath = path.join(dir, "openrouter-key-audit-v1.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const found = findKeys({ stateDir, configPath });
  const gatewayResolvedKey = await resolveOpenRouterKeyViaGateway({
    runCmd,
    clawArgs,
    openclawNode,
    gatewayToken,
    gatewayPort,
  });
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
