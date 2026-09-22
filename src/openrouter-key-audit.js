import fs from "node:fs";
import path from "node:path";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function findKey({ stateDir, configPath }) {
  const sources = [];
  const mainAuth = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const auth = readJson(mainAuth);
  if (auth?.profiles && typeof auth.profiles === "object") {
    for (const [profileId, profile] of Object.entries(auth.profiles)) {
      if (profile?.provider === "openrouter" && profile?.type === "api_key" && typeof profile.key === "string" && profile.key.trim()) {
        sources.push({ source: "main-auth-profile", profileId, key: profile.key.trim() });
      }
    }
  }

  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) sources.push({ source: "process-env", profileId: null, key: envKey });

  const cfg = readJson(configPath);
  const cfgKey = cfg?.env?.vars?.OPENROUTER_API_KEY;
  if (typeof cfgKey === "string" && cfgKey.trim()) {
    sources.push({ source: "config-env", profileId: null, key: cfgKey.trim() });
  }

  return sources[0] || null;
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

  const found = findKey({ stateDir, configPath });
  let result;
  if (!found) {
    result = { ok: false, reason: "openrouter-key-not-resolved" };
  } else {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: { Authorization: `Bearer ${found.key}` },
      });
      let body = null;
      try { body = await res.json(); } catch {}
      const data = body?.data ?? body;
      result = {
        ok: res.ok,
        httpStatus: res.status,
        source: found.source,
        profileId: found.profileId,
        metadata: pickData(data),
        error: res.ok ? null : (data?.error?.message || body?.error?.message || null),
      };
    } catch (err) {
      result = { ok: false, source: found.source, profileId: found.profileId, error: String(err) };
    }
  }

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(resultPath, 0o600); } catch {}
  console.log("[openrouter-key-audit-v1] completed " + JSON.stringify(result));
  return { ran: true, resultPath, ok: Boolean(result.ok) };
}
