import fs from "node:fs";
import path from "node:path";

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

  // v2026.3.x stores provider credentials per agent. Scan only the canonical
  // auth-profile filenames; never inspect transcripts/workspaces for secrets.
  const agentsRoot = path.join(stateDir, "agents");
  try {
    for (const agentId of fs.readdirSync(agentsRoot)) {
      const authPath = path.join(agentsRoot, agentId, "agent", "auth-profiles.json");
      const auth = readJson(authPath);
      if (!auth) continue;

      if (auth.profiles && typeof auth.profiles === "object") {
        for (const [profileId, profile] of Object.entries(auth.profiles)) {
          if (profile?.provider === "openrouter" && typeof profile.key === "string") {
            add({ source: "agent-auth-profile", agentId, profileId, key: profile.key });
          }
        }
      }

      // Older flat shape, migration source only.
      const flat = auth.openrouter;
      if (flat && typeof flat === "object") {
        const flatKey = typeof flat.apiKey === "string" ? flat.apiKey : flat.key;
        if (typeof flatKey === "string") {
          add({ source: "agent-auth-legacy-flat", agentId, profileId: null, key: flatKey });
        }
      }
    }
  } catch {}

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
