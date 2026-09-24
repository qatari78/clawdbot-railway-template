function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function ensureModel(cfg, modelRef) {
  if (!modelRef) return null;
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.models ??= {};
  cfg.agents.defaults.models[modelRef] ??= {};
  return cfg.agents.defaults.models[modelRef];
}

function setSeat(cfg, id, { model, thinking }) {
  const entry = cfg.agents?.entries?.[id];
  if (!entry) return false;
  if (model) {
    entry.model = model;
    ensureModel(cfg, model);
  }
  if (thinking === "provider-default") {
    delete entry.thinkingDefault;
  } else if (thinking) {
    entry.thinkingDefault = thinking;
  }
  return true;
}

export function applyJarvisSeatConfigV1({ cfg }) {
  if (process.env.JARVIS_SEAT_CONFIG_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }
  if (!cfg?.agents?.entries?.main) {
    return { applied: false, reason: "missing-agent-config" };
  }

  const assignments = {
    main: {
      model: process.env.JARVIS_MAIN_MODEL?.trim() || "openrouter/x-ai/grok-4.7",
      thinking: process.env.JARVIS_MAIN_THINKING?.trim() || "high",
    },
    "forum-01": {
      model: process.env.JARVIS_FORUM_01_MODEL?.trim() || "openrouter/qwen/qwen3.8-max-0902",
      thinking: process.env.JARVIS_FORUM_01_THINKING?.trim() || "xhigh",
    },
    "forum-02": {
      model: process.env.JARVIS_FORUM_02_MODEL?.trim() || "openrouter/meta/muse-spark-1.3",
      thinking: process.env.JARVIS_FORUM_02_THINKING?.trim() || "xhigh",
    },
    "forum-03": {
      model: process.env.JARVIS_FORUM_03_MODEL?.trim() || "openrouter/xiaomi/mimo-v2.6-pro",
      thinking: process.env.JARVIS_FORUM_03_THINKING?.trim() || "provider-default",
    },
    "counsel-01": {
      model: process.env.JARVIS_COUNSEL_01_MODEL?.trim() || "openrouter/anthropic/claude-opus-5.5",
      thinking: process.env.JARVIS_COUNSEL_01_THINKING?.trim() || "max",
    },
    "counsel-02": {
      model: process.env.JARVIS_COUNSEL_02_MODEL?.trim() || "openrouter/openai/gpt-6-astra",
      thinking: process.env.JARVIS_COUNSEL_02_THINKING?.trim() || "max",
    },
  };

  for (const [id, spec] of Object.entries(assignments)) setSeat(cfg, id, spec);

  // Keep the default primary aligned with Jarvis/main so any ordinary implicit
  // main-agent run cannot silently fall back to a stale model assignment.
  cfg.agents.defaults.model ??= {};
  if (typeof cfg.agents.defaults.model === "string") {
    cfg.agents.defaults.model = { primary: assignments.main.model };
  } else {
    cfg.agents.defaults.model.primary = assignments.main.model;
  }

  // Forum 3 must use Xiaomi's own endpoint. Keep this as model-level routing so
  // a future seat occupant does not inherit the pin.
  const mimo = ensureModel(cfg, assignments["forum-03"].model);
  mimo.params ??= {};
  mimo.params.provider = {
    order: ["xiaomi"],
    only: ["xiaomi"],
    allow_fallbacks: false,
  };

  // Counsel 3 is a reserved but intentionally unfilled seat. OpenClaw has no
  // generic per-agent "disabled" flag, so remove it from Jarvis's dispatch and
  // agent-to-agent admission paths while preserving the stable workspace/ID.
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

  console.log("[seat-config-v1] reconciled " + JSON.stringify({
    main: assignments.main,
    forum01: assignments["forum-01"],
    forum02: assignments["forum-02"],
    forum03: { ...assignments["forum-03"], provider: "xiaomi-pinned" },
    counsel01: assignments["counsel-01"],
    counsel02: assignments["counsel-02"],
    counsel03Active,
  }));

  return { applied: true, assignments, counsel03Active };
}
