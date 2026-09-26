import fs from "node:fs";
import path from "node:path";

// Seat configuration (v2, 2026-09-26).
//
// - Railway variables (JARVIS_*_MODEL / JARVIS_*_THINKING) are the operator's way to
//   set a seat's model. They are applied ONLY when their value changed since the last
//   boot that applied them. Model switches made by the owner at runtime
//   (`/model <model> -a` in a seat chat, or `/config set agents.entries.<seat>.model=...`)
//   therefore survive restarts instead of being silently reverted.
// - No output-token ceilings: every agent uses its model's native output capacity
//   (Salem's decision, 2026-09-26). Money is guarded by the prepaid balance and the
//   money fuse, not by truncating answers.
// - One-company-per-room is checked on every boot and reported (warn, never block).

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

// An agent's model is either "provider/model" or { primary, fallbacks } (OpenClaw schema).
export function modelRefOf(model) {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
  return null;
}

function ensureModel(cfg, modelRef) {
  if (!modelRef) return null;
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.models ??= {};
  cfg.agents.defaults.models[modelRef] ??= {};
  return cfg.agents.defaults.models[modelRef];
}

function setSeat(cfg, id, { model, thinking, fallbacks }) {
  const entry = cfg.agents?.entries?.[id];
  if (!entry) return false;
  if (model) {
    // F2: only Jarvis gets a fallback list; every seat stays strict (a string model never
    // inherits agents.defaults fallbacks), so no seat is ever swapped silently.
    const list = Array.isArray(fallbacks) ? fallbacks.filter((f) => f && f !== model) : [];
    entry.model = list.length ? { primary: model, fallbacks: list } : model;
    ensureModel(cfg, model);
    for (const f of list) ensureModel(cfg, f);
  }
  if (thinking === "provider-default") {
    delete entry.thinkingDefault;
  } else if (thinking) {
    entry.thinkingDefault = thinking;
  }
  return true;
}

// Lab (company) behind a model reference, for the one-company-per-room rule.
export function labOf(modelRef) {
  const ref = String(modelRef || "").replace(/^openrouter\//, "");
  const vendor = ref.split("/")[0] || "";
  const map = {
    "x-ai": "xAI", xai: "xAI", openai: "OpenAI", anthropic: "Anthropic", qwen: "Alibaba",
    alibaba: "Alibaba", meta: "Meta", "meta-llama": "Meta", xiaomi: "Xiaomi",
    deepseek: "DeepSeek", google: "Google", mistralai: "Mistral", moonshotai: "Moonshot",
  };
  return map[vendor] || vendor || "unknown";
}

export const SEAT_IDS = ["main", "forum-01", "forum-02", "forum-03", "counsel-01", "counsel-02", "counsel-03"];

export function computeLineup(cfg, { counsel03Active = false } = {}) {
  const entries = cfg?.agents?.entries ?? {};
  const seat = (id) => entries[id]
    ? {
      id,
      model: modelRefOf(entries[id].model),
      ...(Array.isArray(entries[id].model?.fallbacks) && entries[id].model.fallbacks.length ? { fallbacks: entries[id].model.fallbacks } : {}),
      thinking: entries[id].thinkingDefault ?? "provider-default",
      lab: labOf(modelRefOf(entries[id].model)),
    }
    : null;
  const forum = ["forum-01", "forum-02", "forum-03"].map(seat).filter(Boolean);
  const counsel = ["counsel-01", "counsel-02", ...(counsel03Active ? ["counsel-03"] : [])].map(seat).filter(Boolean);
  const jarvis = seat("main");
  const research = ["research-01", "research-02"].map(seat).filter(Boolean);
  const warnings = [];
  // Forum: Jarvis chairs with its own view, so it counts toward the Forum's labs.
  const forumLabs = [...forum.map((s) => s.lab), ...(jarvis ? [jarvis.lab] : [])];
  const dupe = (labs) => labs.filter((l, i) => labs.indexOf(l) !== i);
  for (const l of uniq(dupe(forumLabs))) warnings.push(`Forum has two ${l} models (including Jarvis as chair)`);
  // Counsel: Jarvis is clerk-only (no view, no synthesis) when its lab already sits in Counsel.
  for (const l of uniq(dupe(counsel.map((s) => s.lab)))) warnings.push(`Counsel has two ${l} models`);
  const jarvisCounselRole = jarvis && counsel.some((s) => s.lab === jarvis.lab) ? "clerk-only" : "chair";
  return { jarvis, forum, counsel, research, jarvisCounselRole, warnings };
}

export function applyJarvisSeatConfigV1({ cfg, stateDir, workspaceDir } = {}) {
  if (process.env.JARVIS_SEAT_CONFIG_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }
  if (!cfg?.agents?.entries?.main) {
    return { applied: false, reason: "missing-agent-config" };
  }

  const envSeat = (id, modelVar, thinkingVar, model, thinking) => [id, {
    model: process.env[modelVar]?.trim() || model,
    thinking: process.env[thinkingVar]?.trim() || thinking,
  }];
  // F2: Jarvis's approved fallback (a different company from its primary). "none" disables it.
  const mainFallbacksRaw = process.env.JARVIS_MAIN_FALLBACKS?.trim() || "openrouter/x-ai/grok-4.7";
  const mainFallbacks = mainFallbacksRaw === "none" ? [] : mainFallbacksRaw.split(",").map((x) => x.trim()).filter(Boolean);
  const mainSeat = envSeat("main", "JARVIS_MAIN_MODEL", "JARVIS_MAIN_THINKING", "openrouter/openai/gpt-6-sol", "high");
  mainSeat[1].fallbacks = mainFallbacks;
  const assignments = Object.fromEntries([
    mainSeat,
    envSeat("forum-01", "JARVIS_FORUM_01_MODEL", "JARVIS_FORUM_01_THINKING", "openrouter/qwen/qwen3.8-max-0902", "xhigh"),
    envSeat("forum-02", "JARVIS_FORUM_02_MODEL", "JARVIS_FORUM_02_THINKING", "openrouter/meta/muse-spark-1.3", "xhigh"),
    envSeat("forum-03", "JARVIS_FORUM_03_MODEL", "JARVIS_FORUM_03_THINKING", "openrouter/xiaomi/mimo-v2.6-pro", "provider-default"),
    envSeat("counsel-01", "JARVIS_COUNSEL_01_MODEL", "JARVIS_COUNSEL_01_THINKING", "openrouter/anthropic/claude-opus-5.5", "max"),
    envSeat("counsel-02", "JARVIS_COUNSEL_02_MODEL", "JARVIS_COUNSEL_02_THINKING", "openrouter/openai/gpt-6-astra", "max"),
    // Researchers are swappable seats too (G3); the research system only fills them when missing.
    envSeat("research-01", "JARVIS_RESEARCH_VERIFIER_MODEL", "JARVIS_RESEARCH_VERIFIER_THINKING", "openrouter/openai/gpt-6-sol", "high"),
    envSeat("research-02", "JARVIS_RESEARCH_SCOUT_MODEL", "JARVIS_RESEARCH_SCOUT_THINKING", "openrouter/deepseek/deepseek-v4-flash-0731", "high"),
  ]);

  // Apply a seat's Railway variables only when they changed since the last boot that
  // applied them; otherwise keep whatever the owner has configured at runtime.
  const snapshotPath = stateDir ? path.join(stateDir, "jarvis-seat-env-applied.json") : null;
  let applied = {};
  if (snapshotPath) {
    try { applied = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) || {}; } catch { applied = {}; }
  }
  const envApplied = [];
  const keptRuntime = [];
  for (const [id, spec] of Object.entries(assignments)) {
    const sig = JSON.stringify(spec);
    if (applied[id] === sig) { keptRuntime.push(id); continue; }
    if (setSeat(cfg, id, spec)) {
      applied[id] = sig;
      envApplied.push(id);
    }
  }
  if (snapshotPath) {
    try { fs.writeFileSync(snapshotPath, JSON.stringify(applied, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); } catch {}
  }

  // No output ceilings anywhere (removes the 32k envelope GPT applied on 2026-09-26).
  let capsRemoved = 0;
  for (const entry of Object.values(cfg.agents.entries ?? {})) {
    if (entry?.params && typeof entry.params === "object" && "maxTokens" in entry.params) {
      delete entry.params.maxTokens;
      capsRemoved += 1;
      if (Object.keys(entry.params).length === 0) delete entry.params;
    }
  }
  for (const modelCfg of Object.values(cfg.agents.defaults?.models ?? {})) {
    if (modelCfg?.params && typeof modelCfg.params === "object" && "maxTokens" in modelCfg.params) {
      delete modelCfg.params.maxTokens;
      capsRemoved += 1;
      if (Object.keys(modelCfg.params).length === 0) delete modelCfg.params;
    }
  }

  // Keep the default primary aligned with Jarvis's configured model (runtime switches included).
  const mainModel = modelRefOf(cfg.agents.entries.main.model);
  cfg.agents.defaults.model ??= {};
  if (typeof cfg.agents.defaults.model === "string") {
    cfg.agents.defaults.model = { primary: mainModel };
  } else {
    cfg.agents.defaults.model.primary = mainModel;
  }

  // MiMo must use Xiaomi's own endpoint (model-level routing, so a future occupant
  // of Forum 3 does not inherit the pin).
  for (const [ref, modelCfg] of Object.entries(cfg.agents.defaults.models ?? {})) {
    if (labOf(ref) !== "Xiaomi") continue;
    modelCfg.params ??= {};
    modelCfg.params.provider = { order: ["xiaomi"], only: ["xiaomi"], allow_fallbacks: false };
  }

  // Counsel 3 is a reserved but intentionally unfilled seat.
  const counsel03Active = process.env.JARVIS_COUNSEL_03_ACTIVE?.trim() === "1";
  const main = cfg.agents.entries.main;
  main.subagents ??= {};
  const allow = Array.isArray(main.subagents.allowAgents) ? main.subagents.allowAgents : [];
  main.subagents.allowAgents = counsel03Active
    ? uniq([...allow, "counsel-03"])
    : allow.filter((id) => id !== "counsel-03");
  cfg.tools ??= {};
  cfg.tools.agentToAgent ??= {};
  const a2a = Array.isArray(cfg.tools.agentToAgent.allow) ? cfg.tools.agentToAgent.allow : [];
  cfg.tools.agentToAgent.allow = counsel03Active
    ? uniq([...a2a, "counsel-03"])
    : a2a.filter((id) => id !== "counsel-03");
  const c3 = cfg.agents.entries["counsel-03"];
  if (c3) {
    c3.identity ??= {};
    if (!counsel03Active) {
      c3.name = "Counsel 3 (OPEN)";
      c3.identity.name = "Counsel 3 (OPEN)";
    }
  }

  const lineup = computeLineup(cfg, { counsel03Active });
  if (workspaceDir) {
    try {
      const dir = path.join(workspaceDir, "reports");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "lineup.json"), JSON.stringify({ at: new Date().toISOString(), ...lineup }, null, 2) + "\n", { mode: 0o600 });
    } catch {}
  }
  console.log("[seat-config-v2] reconciled " + JSON.stringify({
    jarvis: lineup.jarvis,
    forum: lineup.forum,
    counsel: lineup.counsel,
    jarvisCounselRole: lineup.jarvisCounselRole,
    counsel03Active,
    envApplied,
    keptRuntime,
    outputCap: "none",
    capsRemoved,
  }));
  for (const w of lineup.warnings) console.warn("[seat-config-v2] ONE-LAB WARNING: " + w);

  return { applied: true, assignments, counsel03Active, lineup };
}
