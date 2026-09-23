import fs from "node:fs";
import path from "node:path";

export const PERMANENT_ADVISER_IDS = [
  "forum-01",
  "forum-02",
  "forum-03",
  "counsel-01",
  "counsel-02",
  "counsel-03",
];

const POLICY_START = "<!-- jarvis-adviser-memory-v1:start -->";
const POLICY_END = "<!-- jarvis-adviser-memory-v1:end -->";

function unique(items) {
  return Array.from(new Set(items.filter((item) => typeof item === "string" && item.trim())));
}

function backupOnce(filePath, backupDir, backupName) {
  if (!fs.existsSync(filePath)) return;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dst = path.join(backupDir, backupName);
  if (!fs.existsSync(dst)) fs.copyFileSync(filePath, dst);
}

function upsertManagedBlock(filePath, heading, lines, backupDir, backupName) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const block = [
    heading,
    POLICY_START,
    ...lines,
    POLICY_END,
  ].join("\n");

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
    backupOnce(filePath, backupDir, backupName);
  }

  const start = existing.indexOf(POLICY_START);
  const end = existing.indexOf(POLICY_END);
  let next;
  if (start >= 0 && end >= start) {
    const headingStart = existing.lastIndexOf(heading, start);
    const replaceStart = headingStart >= 0 ? headingStart : start;
    next = existing.slice(0, replaceStart) + block + existing.slice(end + POLICY_END.length);
  } else {
    next = existing.trimEnd();
    next = (next ? next + "\n\n" : "") + block + "\n";
  }

  if (next !== existing) {
    fs.writeFileSync(filePath, next, { encoding: "utf8", mode: 0o600 });
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return next !== existing;
}

function ensurePrivateMemoryFile(workspace, displayName) {
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const memoryPath = path.join(workspace, "MEMORY.md");
  if (!fs.existsSync(memoryPath)) {
    const body = [
      `# ${displayName} — private adviser memory`,
      "",
      "This is the durable memory of this permanent adviser seat.",
      "It is separate from Jarvis's canonical shared memory and from every other adviser's private memory.",
      "Memory Core may consolidate durable adviser-specific lessons here from this seat's own eligible interactions.",
      "Never store passwords, API keys, bot tokens, provider credentials, or other secrets here.",
      "",
    ].join("\n");
    fs.writeFileSync(memoryPath, body, { encoding: "utf8", mode: 0o600 });
  }
  try { fs.chmodSync(memoryPath, 0o600); } catch {}
  return memoryPath;
}

export function applyJarvisAdviserMemoryV1({ cfg, mainWorkspaceDir }) {
  if (!cfg?.agents?.entries || !mainWorkspaceDir) {
    return { applied: false, reason: "missing-config-or-workspace" };
  }

  const sharedMemoryFile = path.join(mainWorkspaceDir, "MEMORY.md");
  const sharedMemoryDir = path.join(mainWorkspaceDir, "memory");
  const backupRoot = path.join(
    mainWorkspaceDir,
    "memory",
    ".seed-backups",
    "2026-09-23-adviser-memory-v1",
  );

  cfg.agents.defaults ??= {};
  cfg.agents.defaults.systemAgent ??= {};
  cfg.agents.defaults.systemAgent.agentId = "main";

  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries["active-memory"] ??= {};
  cfg.plugins.entries["active-memory"].enabled = true;
  cfg.plugins.entries["active-memory"].config ??= {};
  const active = cfg.plugins.entries["active-memory"].config;
  active.enabled = true;
  active.mode = active.mode === "always" ? "always" : "escalate";
  active.agents = unique([
    ...(Array.isArray(active.agents) ? active.agents : []),
    ...PERMANENT_ADVISER_IDS.filter((id) => Boolean(cfg.agents.entries[id])),
  ]);
  active.allowedChatTypes = unique([
    ...(Array.isArray(active.allowedChatTypes) ? active.allowedChatTypes : []),
    "direct",
    "explicit",
  ]);

  const applied = [];
  for (const id of PERMANENT_ADVISER_IDS) {
    const entry = cfg.agents.entries[id];
    if (!entry) continue;

    entry.memory ??= {};
    entry.memory.search ??= {};
    entry.memory.search.enabled = true;
    entry.memory.search.rememberAcrossConversations = true;
    entry.memory.search.sources = ["memory", "sessions"];
    entry.memory.search.extraPaths = unique([
      ...(Array.isArray(entry.memory.search.extraPaths) ? entry.memory.search.extraPaths : []),
      sharedMemoryFile,
      sharedMemoryDir,
    ]);

    entry.tools ??= {};
    entry.tools.alsoAllow = unique([
      ...(Array.isArray(entry.tools.alsoAllow) ? entry.tools.alsoAllow : []),
      "memory_search",
      "memory_get",
    ]);
    if (Array.isArray(entry.tools.deny)) {
      entry.tools.deny = entry.tools.deny.filter(
        (tool) => tool !== "memory_search" && tool !== "memory_get",
      );
    }

    const workspace = entry.workspace || path.join("/data/agent-workspaces", id);
    entry.workspace = workspace;
    const displayName = entry.identity?.name || entry.name || id;
    ensurePrivateMemoryFile(workspace, displayName);

    const seatBackupDir = path.join(backupRoot, id);
    upsertManagedBlock(
      path.join(workspace, "AGENTS.md"),
      "## Jarvis Adviser Memory Architecture v1",
      [
        "- This is a permanent adviser seat with its own durable memory namespace.",
        "- Your private durable memory is your workspace MEMORY.md plus memory/*.md and your own eligible session history.",
        "- Jarvis's canonical shared factual backbone remains separate at /data/workspace/MEMORY.md and /data/workspace/memory. It is indexed for reference; do not treat it as your private recollection or rewrite it.",
        "- Never read, claim, copy, or impersonate another adviser's private memory. If a fact came from the shared backbone, describe it as shared context rather than something you personally remember saying.",
        "- /new and /reset clear active conversational context; they do not erase durable memory.",
        "- Preserve adviser-specific conclusions, prior positions, recurring reasoning lessons, and owner-approved durable preferences when they are genuinely useful later.",
        "- Do not store secrets, credentials, authentication material, or transient room scratch data in durable memory.",
      ],
      seatBackupDir,
      "AGENTS.md.pre-adviser-memory-v1",
    );
    upsertManagedBlock(
      path.join(workspace, "USER.md"),
      "## Persistent adviser continuity",
      [
        "- You serve the owner through Jarvis while retaining your own adviser continuity across eligible private sessions.",
        "- Shared owner facts come from Jarvis's canonical memory; your own durable memory is for this seat's adviser-specific history and lessons.",
        "- Do not falsely attribute shared facts or another adviser's statements to your own memory.",
      ],
      seatBackupDir,
      "USER.md.pre-adviser-memory-v1",
    );

    applied.push({ id, workspace });
  }

  console.log("[adviser-memory-v1] reconciled " + JSON.stringify({
    advisers: applied.map((item) => item.id),
    sharedBackbone: [sharedMemoryFile, sharedMemoryDir],
    activeMemory: true,
  }));

  return {
    applied: true,
    advisers: applied,
    sharedBackbone: [sharedMemoryFile, sharedMemoryDir],
    backupRoot,
  };
}
