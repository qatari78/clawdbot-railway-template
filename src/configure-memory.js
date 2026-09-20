import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";

const stateDir =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(process.env.HOME || "/root", ".openclaw");

const workspaceDir =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(stateDir, "workspace");

const configPath =
  process.env.OPENCLAW_CONFIG_PATH?.trim() ||
  path.join(stateDir, "openclaw.json");

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runOpenClaw(args, timeoutMs = 180000) {
  const r = childProcess.spawnSync(
    process.env.OPENCLAW_NODE?.trim() || "node",
    [process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js", ...args],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspaceDir,
      },
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  const output = [r.stdout, r.stderr].filter(Boolean).join("");
  return { code: r.status ?? 1, output };
}

try {
  if (!fs.existsSync(configPath)) {
    console.log("[memory-bootstrap] config not present yet; skipping");
    process.exit(0);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(raw);
  const before = structuredClone(cfg);

  cfg.models ??= {};
  cfg.models.mode ??= "merge";
  cfg.models.providers ??= {};
  delete cfg.models.providers["openrouter-memory"];
  cfg.models.providers.openrouter = {
    ...(cfg.models.providers.openrouter || {}),
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "openrouter:default",
  };

  cfg.memory ??= {};
  cfg.memory.search ??= {};
  cfg.memory.search.enabled = true;
  cfg.memory.search.provider = "openrouter";
  cfg.memory.search.model = "openai/text-embedding-3-small";
  cfg.memory.search.fallback = "none";
  cfg.memory.search.rememberAcrossConversations = true;

  let changed = !same(before, cfg);
  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${configPath}.bak-memory-${stamp}`;
    fs.copyFileSync(configPath, backup);
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`[memory-bootstrap] config updated; backup=${backup}`);
  } else {
    console.log("[memory-bootstrap] config already current");
  }

  const status = runOpenClaw(["memory", "status", "--deep", "--agent", "main"]);
  console.log(`[memory-bootstrap] status exit=${status.code}\n${status.output}`);

  if (changed || status.code !== 0) {
    const index = runOpenClaw(
      ["memory", "index", "--force", "--agent", "main"],
      10 * 60 * 1000,
    );
    console.log(`[memory-bootstrap] index exit=${index.code}\n${index.output}`);
  }

  const test = runOpenClaw(
    ["memory", "search", "Jarvis", "--agent", "main"],
    180000,
  );
  console.log(`[memory-bootstrap] search-test exit=${test.code}\n${test.output}`);

  // Always hand off to the wrapper in-process. This makes startup safe whether
  // Railway invokes this bootstrap directly or the normal server command.
  console.log("[memory-bootstrap] starting wrapper");
  await import("./server.js");
} catch (err) {
  console.warn(`[memory-bootstrap] non-fatal error: ${String(err)}`);
  console.log("[memory-bootstrap] starting wrapper after non-fatal error");
  await import("./server.js");
}
