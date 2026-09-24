import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { installJarvisTelegramDepositV1 } from "./telegram-token-deposit.js";
import { installJarvisRoomsV1 } from "./jarvis-rooms.js";
import { installJarvisCostIntelligenceV1 } from "./jarvis-cost-intelligence.js";

function upsertManagedBlock(filePath, beginMarker, endMarker, body) {
  const block = beginMarker + "\n" + body.trim() + "\n" + endMarker;
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker);
  if (start >= 0 && end > start) {
    text = text.slice(0, start) + block + text.slice(end + endMarker.length);
  } else {
    text = text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, text.trimEnd() + "\n", { encoding: "utf8", mode: 0o600 });
}


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


function applyJarvisWhatsAppRoomsV1(workspaceDir) {
  if (process.env.JARVIS_WHATSAPP_ROOMS_V1?.trim() !== "1") {
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
    "2026-09-22-whatsapp-rooms-v1",
  );

  if (!fs.existsSync(configPath) || !fs.existsSync(agentsPath)) {
    console.warn("[whatsapp-rooms-v1] config or AGENTS.md missing; skipping");
    return { applied: false, reason: "missing-files" };
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackupPath = path.join(backupDir, "openclaw.json.pre-whatsapp-rooms");
  const agentsBackupPath = path.join(backupDir, "AGENTS.md.pre-whatsapp-rooms");
  if (!fs.existsSync(configBackupPath)) fs.copyFileSync(configPath, configBackupPath);
  if (!fs.existsSync(agentsBackupPath)) fs.copyFileSync(agentsPath, agentsBackupPath);

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.channels ??= {};
  cfg.channels.whatsapp ??= {};

  const root = cfg.channels.whatsapp;
  const target = root.accounts?.default ?? root;
  const explicitOwner = process.env.JARVIS_WHATSAPP_OWNER_E164?.trim();

  const ownerAllow =
    (explicitOwner
      ? [explicitOwner]
      : Array.isArray(target.allowFrom) && target.allowFrom.length > 0
        ? target.allowFrom
        : Array.isArray(root.allowFrom) && root.allowFrom.length > 0
          ? root.allowFrom
          : null);

  const enableScope = (scope) => {
    scope.groupPolicy = "allowlist";
    scope.groups ??= {};
    scope.groups["*"] = {
      ...(scope.groups["*"] ?? {}),
      requireMention: false,
    };
    if (ownerAllow) {
      scope.groupAllowFrom = Array.from(new Set(ownerAllow));
    }
  };

  // Set both the channel root and the effective default account. OpenClaw's
  // WhatsApp runtime resolves policy across both scopes in multi-account configs.
  enableScope(root);
  if (target !== root) enableScope(target);

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
    fs.copyFileSync(configBackupPath, configPath);
    throw new Error("OpenClaw rejected WhatsApp room configuration; restored previous config");
  }

  const marker = "## Jarvis WhatsApp Rooms v1";
  const policy = `
## Jarvis WhatsApp Rooms v1

- WhatsApp DM with the owner is the Jarvis cockpit. Explicit requests such as "Forum: ...", "ask Forum ...", "Counsel: ...", or "Jarvis, Counsel. Go." invoke the corresponding internal room and return the result to the DM.
- A WhatsApp group whose title/metadata identifies it as Forum is a persistent Forum surface. Owner messages in that group are Forum turns by default; no repeated "Forum" prefix is required.
- A WhatsApp group whose title/metadata identifies it as Counsel is a persistent Counsel surface. Owner messages in that group are Counsel turns by default and count as explicit owner invocation of Counsel.
- The single linked WhatsApp identity remains Jarvis. Do not impersonate multiple WhatsApp accounts or claim that backend advisers are separate WhatsApp participants.
- When exposing individual room voices, label the permanent seat first: [JARVIS], [FORUM 1], [FORUM 2], [FORUM 3], [COUNSEL 1], [COUNSEL 2], [COUNSEL 3]. A current model name may be shown only as secondary metadata resolved from seat configuration; never hard-code a model into room identity or orchestration.
- If the owner addresses a specific adviser/model, route to that permanent seat and return that seat's own view. If the owner asks everyone, obtain independent room views. Synthesis is a separate task performed only when requested and may be assigned to any model/seat selected for that run; Jarvis transports the attributed output on WhatsApp.
- Forum can recommend Counsel but cannot invoke it. Only an owner message in the Counsel group or an explicit owner Counsel command authorizes Counsel.
- Keep WhatsApp DM, Forum group, and Counsel group as separate conversation sessions. Do not merge their transient chat histories.
`.trim();

  let agents = fs.readFileSync(agentsPath, "utf8");
  const count = (agents.match(/## Jarvis WhatsApp Rooms v1/g) || []).length;
  if (count === 0) {
    fs.writeFileSync(
      agentsPath,
      agents.trimEnd() + "\n\n" + policy + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } else if (count > 1) {
    throw new Error("duplicate Jarvis WhatsApp Rooms v1 markers found");
  }

  // Human-facing room rendering v2. Keep v1 transport/routing intact, but
  // add a stronger presentation contract for WhatsApp room turns.
  const renderingMarker = "## Jarvis WhatsApp Room Rendering v2";
  const renderingPolicy = `
## Jarvis WhatsApp Room Rendering v2

- For a substantive multi-seat Forum or Counsel run, collect and lock all first-round adviser outputs before publishing any adviser voice. Message order must never leak an earlier answer to advisers who are still thinking.
- On WhatsApp, do not concatenate several model voices into one giant Jarvis bubble. After all required adviser outputs are locked, publish each exposed speaker as a separate outbound WhatsApp message to the same current conversation target.
- Use compact human-facing headers without square brackets. Put the stable seat first, for example *FORUM 1* or *COUNSEL 2*. A current configured model/display alias may be shown secondarily, but the seat label is canonical.
- Do not hard-code a provider/model into backend room logic. If a seat's configured model changes, update only the human-facing model/display alias shown in the header.
- A peer-review message, when one exists, is its own WhatsApp message with a compact header such as *COUNSEL 2 · RESPONSE TO COUNSEL 3*.
- When synthesis is requested, publish it as a separate WhatsApp message and identify the actual synthesizing model/seat for that run. No numbered seat has permanent synthesis authority.
- Use the supported message tool to send these separate bubbles only after the relevant outputs are locked. When tool-sent bubbles already contain the complete response, use NO_REPLY (or the runtime-equivalent suppression) for the wrapper response so the same content is not duplicated.
- If the current WhatsApp target cannot be resolved safely, do not guess a recipient. Fall back to the normal single response for that turn and report the rendering limitation.
- The single linked WhatsApp identity remains Jarvis. Separate bubbles are presentation only; backend advisers are not separate WhatsApp accounts.
`.trim();

  let renderingAgents = fs.readFileSync(agentsPath, "utf8");
  const renderingCount = (renderingAgents.match(/## Jarvis WhatsApp Room Rendering v2/g) || []).length;
  if (renderingCount === 0) {
    fs.writeFileSync(
      agentsPath,
      renderingAgents.trimEnd() + "\n\n" + renderingPolicy + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } else if (renderingCount > 1) {
    throw new Error("duplicate Jarvis WhatsApp Room Rendering v2 markers found");
  }


  const seatChannelPolicyV3 = [
    "## Jarvis Seat and Channel Contract v3",
    "",
    "- This v3 contract supersedes any conflicting model-specific or Jarvis-synthesis wording in earlier WhatsApp room/rendering, multi-agent routing, or non-revenue-token policies.",
    "- Permanent seat IDs are the canonical identities. Model/provider assignments are replaceable occupants and must never define the room role.",
    "- Jarvis prepares the scoped case/evidence packet, commissions centralized research, and orchestrates room calls. Synthesis is a separate task only when requested; no numbered seat is inherently the chair or synthesizer.",
    "- Seat numbers are identity/memory/channel slots only. The synthesis model/seat is selected per run by the active synthesis policy or the owner's explicit instruction and may change without altering any permanent seat.",
    "- Telegram: a bound adviser seat speaks and sends its own artifacts under its own Telegram bot/account identity, using the Telegram accountId that matches the stable seat ID. If that seat is selected to synthesize a run, it may publish the synthesis/artifact under its own identity. If a non-seat model or Jarvis synthesizes, identify the actual synthesizer and do not impersonate a numbered seat. If a seat has no Telegram bot binding yet, report direct delivery as pending.",
    "- WhatsApp: the single visible identity remains Jarvis. Jarvis transports room messages and artifacts but attributes them to the permanent authoring seat. Jarvis transport does not change intellectual authorship.",
    "- Telegram account bindings belong to seats, not models. A future model swap behind a seat must not require rebinding that seat's Telegram identity.",
    "",
  ].join("\n");
  upsertManagedBlock(
    agentsPath,
    "<!-- BEGIN jarvis-seat-channel-contract-v3 -->",
    "<!-- END jarvis-seat-channel-contract-v3 -->",
    seatChannelPolicyV3,
  );

  console.log("[whatsapp-rooms-v1] group transport enabled and room routing policy verified");
  return { applied: true, backupDir, ownerAllowConfigured: Boolean(ownerAllow) };
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
    { id: "forum-01", label: "Forum 1", role: "forum", model: process.env.JARVIS_FORUM_01_MODEL?.trim() },
    { id: "forum-02", label: "Forum 2", role: "forum", model: process.env.JARVIS_FORUM_02_MODEL?.trim() },
    { id: "forum-03", label: "Forum 3", role: "forum", model: process.env.JARVIS_FORUM_03_MODEL?.trim() },
    { id: "counsel-01", label: "Counsel 1", role: "counsel", model: process.env.JARVIS_COUNSEL_01_MODEL?.trim() },
    { id: "counsel-02", label: "Counsel 2", role: "counsel", model: process.env.JARVIS_COUNSEL_02_MODEL?.trim() },
    { id: "counsel-03", label: "Counsel 3", role: "counsel", model: process.env.JARVIS_COUNSEL_03_MODEL?.trim() },
    { id: "research-01", label: "Research 1", role: "research", model: process.env.JARVIS_RESEARCH_01_MODEL?.trim() },
    { id: "research-02", label: "Research 2", role: "research", model: process.env.JARVIS_RESEARCH_02_MODEL?.trim() },
  ];
  const stableIds = seats.map((seat) => seat.id);
  const allAgentIds = ["main", ...stableIds];

  const commonUser = [
    "# USER.md",
    "",
    "You serve the owner through Jarvis.",
    "Personal context is supplied only when relevant to the scoped task/case packet.",
    "Permanent adviser seats may retain their own approved adviser-specific durable memory; research workers do not.",
    "",
  ].join("\n");

  const forumRules = [
    "# Forum Adviser Rules",
    "",
    "- You are a permanent Forum adviser seat, not Jarvis. Seat identity is stable even when the model/provider occupant changes.",
    "- Work from the shared case packet/evidence packet supplied by Jarvis.",
    "- One adviser pass by default; a second pass only when Jarvis sends a material contradiction or gap.",
    "- Do not invoke Counsel. Only the owner may authorize Counsel.",
    "- Do not spawn subagents or do independent browsing/research.",
    "- If evidence is missing, send a concise research request to agent:main:main and continue only with clearly marked assumptions.",
    "- When directly addressed, answer as this seat, not as Jarvis and not as a synthetic consensus.",
    "- No Forum seat is permanently the chair or synthesizer. If this seat is selected to synthesize a run, synthesis is a separate fresh task after peer outputs are locked.",
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
    "- No Counsel seat is permanently the chair or synthesizer. If this seat is selected to synthesize a run, synthesis is a separate fresh task after peer outputs are locked.",
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


  for (const seat of seats) {
    const seatAgentsPath = path.join(agentRoot, seat.id, "AGENTS.md");
    const lines = [
      "## Stable Seat Contract v2",
      "",
      "- Your permanent identity is the seat " + seat.id + "; the model/provider occupying this seat may change without changing your role or memory identity.",
      "- Never claim that your current model name is your permanent identity.",
    ];
    if (seat.role === "forum") {
      lines.push(
        "- All Forum seats answer the frozen case packet independently before any current-run peer answer is revealed.",
        "- No Forum seat has permanent chair or synthesis authority. If this seat is selected as synthesizer for a run, use a separate fresh synthesis context after all required adviser outputs are locked.",
        "- Seat numbering does not imply hierarchy; the synthesis target may change from run to run.",
      );
    } else if (seat.role === "counsel") {
      lines.push(
        "- No Counsel seat has permanent chair or synthesis authority. If this seat is selected as synthesizer for a run, use a separate fresh synthesis context after all required adviser outputs are locked.",
        "- Seat numbering does not imply hierarchy; the synthesis target may change from run to run.",
      );
    } else {
      lines.push("- Research seats gather evidence only and never become room synthesizers.");
    }
    lines.push(
      "- If this seat has a bound Telegram bot/account and is asked to publish on Telegram, use the Telegram accountId matching this stable seat ID and speak/send artifacts under that seat identity. On WhatsApp, Jarvis is transport only and must attribute your output to this seat.",
      "",
    );
    upsertManagedBlock(
      seatAgentsPath,
      "<!-- BEGIN stable-seat-contract-v2 -->",
      "<!-- END stable-seat-contract-v2 -->",
      lines.join("\n"),
    );
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
  cfg.agents.defaults.heartbeat ??= {};
  if (cfg.agents.defaults.heartbeat.every !== "0m") {
    cfg.agents.defaults.heartbeat.every = "0m";
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

  const adviserAllow = ["message", "sessions_send", "session_status", "memory_search", "memory_get"];
  const adviserDeny = [
    "read",
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
  const researchAllow = ["browser", "web_search", "web_fetch"];
  const researchDeny = [
    "read",
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
    const isResearch = seat.role === "research";
    const desiredAllow = isResearch ? researchAllow : adviserAllow;
    const desiredDeny = isResearch ? researchDeny : adviserDeny;
    const existingSeat = cfg.agents.entries[seat.id];

    if (!existingSeat) {
      cfg.agents.entries[seat.id] = {
        name: seat.label,
        workspace: path.join(agentRoot, seat.id),
        identity: { name: seat.label },
        ...(seat.model ? { model: seat.model } : {}),
        tools: {
          allow: desiredAllow,
          deny: desiredDeny,
        },
      };
      configChanged = true;
      continue;
    }

    if (seat.model && existingSeat.model !== seat.model) {
      existingSeat.model = seat.model;
      configChanged = true;
    }

    existingSeat.tools ??= {};
    // OpenClaw rejects allow + alsoAllow in the same agent tool scope. Runtime
    // policy later converts advisers to profile:minimal + alsoAllow, so the
    // scaffold must normalize back to its authoritative explicit allowlist
    // before validation on each boot.
    if (existingSeat.tools.alsoAllow !== undefined) {
      delete existingSeat.tools.alsoAllow;
      configChanged = true;
    }
    if (JSON.stringify(existingSeat.tools.allow ?? []) !== JSON.stringify(desiredAllow)) {
      existingSeat.tools.allow = desiredAllow;
      configChanged = true;
    }
    if (JSON.stringify(existingSeat.tools.deny ?? []) !== JSON.stringify(desiredDeny)) {
      existingSeat.tools.deny = desiredDeny;
      configChanged = true;
    }
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
      // Roll back to the exact config read at the start of this invocation.
      // Never restore the one-time historical seed backup here: that snapshot
      // can predate later agents/channels/memory changes and cause data loss.
      fs.writeFileSync(configPath, originalConfigText, { encoding: "utf8", mode: 0o600 });
      throw new Error("OpenClaw rejected multi-agent scaffold config; restored current pre-mutation config");
    }
  }

  const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const id of stableIds) {
    if (!verified.agents?.entries?.[id]) {
      throw new Error("multi-agent scaffold verification failed: missing " + id);
    }
    const expectedSeat = seats.find((seat) => seat.id === id);
    if (expectedSeat?.model && verified.agents.entries[id].model !== expectedSeat.model) {
      throw new Error("multi-agent scaffold verification failed: model assignment mismatch on " + id);
    }
    if (!verified.agents?.entries?.main?.subagents?.allowAgents?.includes(id)) {
      throw new Error("multi-agent scaffold verification failed: main cannot spawn " + id);
    }
    const seatTools = verified.agents.entries[id].tools ?? {};
    if (seatTools.allow?.includes("read") || !seatTools.deny?.includes("read")) {
      throw new Error("multi-agent scaffold verification failed: filesystem read still enabled on " + id);
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
    "- Forum runs only when the owner invokes or addresses Forum. Jarvis builds one shared case/evidence packet and orchestrates the seats. For a full Forum run, participating seats answer independently first. Synthesis is added only when requested and is assigned separately to the model/seat selected for that run. A directly addressed seat answers as itself. Models are replaceable occupants and seat numbers never define hierarchy.",
    "- Forum may recommend Counsel but must never invoke it.",
    "- Counsel runs only after explicit owner authorization. It inherits the structured dossier, performs delta/deeper research as needed through research-01/02, and obtains independent Counsel views. Synthesis is added only when requested and is assigned separately to the model/seat selected for that run. Counsel remains conversational for follow-ups.",
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
    installJarvisCostIntelligenceV1(workspaceDir);
  } catch (err) {
    console.warn(`[cost-intelligence-v1] failed: ${String(err)}`);
  }

  try {
    installJarvisRoomsV1(workspaceDir);
  } catch (err) {
    console.warn(`[jarvis-rooms-v1] failed: ${String(err)}`);
  }

  try {
    applyJarvisOrchestrationPolicyV1(workspaceDir);
  } catch (err) {
    console.warn(`[orchestration-v1] failed: ${String(err)}`);
  }

  try {
    applyJarvisWhatsAppRoomsV1(workspaceDir);
  } catch (err) {
    console.warn(`[whatsapp-rooms-v1] failed: ${String(err)}`);
  }

  try {
    applyJarvisMultiAgentScaffoldV1(workspaceDir);
  } catch (err) {
    console.warn(`[multi-agent-v1] failed: ${String(err)}`);
  }

  try {
    installJarvisTelegramDepositV1(workspaceDir);
  } catch (err) {
    console.warn(`[telegram-deposit-v1] failed: ${String(err)}`);
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
