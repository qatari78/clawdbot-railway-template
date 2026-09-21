import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function installJarvisTelegramDepositV1(workspaceDir) {
  if (process.env.JARVIS_TELEGRAM_DEPOSIT_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }

  const root = path.resolve(workspaceDir);
  const controlDir = path.join(root, "control");
  const skillDir = path.join(root, "skills", "telegram-token-deposit");
  const intakeDir = path.join(root, ".secret-intake");
  const scriptPath = path.join(controlDir, "telegram-token-vault.mjs");
  const skillPath = path.join(skillDir, "SKILL.md");
  const registryPath = path.join(controlDir, "telegram-token-registry.json");
  const agentsPath = path.join(root, "AGENTS.md");

  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(intakeDir, { recursive: true, mode: 0o700 });

  const vaultScript = [
    "#!/usr/bin/env node",
    "import childProcess from \"node:child_process\";",
    "import fs from \"node:fs\";",
    "import os from \"node:os\";",
    "import path from \"node:path\";",
    "",
    "const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || process.env.CLAWDBOT_WORKSPACE_DIR?.trim() || \"/data/workspace\";",
    "const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), \".openclaw\");",
    "const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, \"openclaw.json\");",
    "const controlDir = path.join(workspaceDir, \"control\");",
    "const intakeDir = path.join(workspaceDir, \".secret-intake\");",
    "const registryPath = path.join(controlDir, \"telegram-token-registry.json\");",
    "const backupDir = path.join(workspaceDir, \"memory\", \".seed-backups\", \"telegram-token-bindings\");",
    "",
    "function fail(message, code = 1) { process.stderr.write(String(message) + \"\\n\"); process.exit(code); }",
    "function normalizeLabel(raw) {",
    "  let value = String(raw || \"\").trim().toLowerCase();",
    "  value = value.replace(/^forum[\\s_-]*0?([123])$/, \"forum-0$1\").replace(/^counsel[\\s_-]*0?([123])$/, \"counsel-0$1\").replace(/^research[\\s_-]*0?([12])$/, \"research-0$1\").replace(/\\s+/g, \"-\").replace(/[^a-z0-9_-]/g, \"-\").replace(/-+/g, \"-\").replace(/^[-_]+|[-_]+$/g, \"\");",
    "  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) fail(\"Invalid label. Use a short label such as forum-01 or counsel-02.\");",
    "  return value;",
    "}",
    "function secretNameFor(label) { return \"TELEGRAM_\" + label.toUpperCase().replace(/[^A-Z0-9]+/g, \"_\") + \"_BOT_TOKEN\"; }",
    "function loadRegistry() { try { const parsed = JSON.parse(fs.readFileSync(registryPath, \"utf8\")); return parsed && typeof parsed === \"object\" ? parsed : { version: 1, entries: {} }; } catch { return { version: 1, entries: {} }; } }",
    "function saveRegistry(registry) { fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + \"\\n\", { encoding: \"utf8\", mode: 0o600 }); }",
    "function runOpenClaw(args, options = {}) { return childProcess.spawnSync(process.execPath, [\"/openclaw/dist/entry.js\", ...args], { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir, OPENCLAW_CONFIG_PATH: configPath }, encoding: \"utf8\", timeout: 60000, ...options }); }",
    "",
    "function deposit(rawLabel, tokenFile) {",
    "  const label = normalizeLabel(rawLabel);",
    "  const resolved = path.resolve(String(tokenFile || \"\"));",
    "  const intakeRoot = path.resolve(intakeDir);",
    "  if (!(resolved === intakeRoot || resolved.startsWith(intakeRoot + path.sep))) fail(\"Token file must be inside the Jarvis secret-intake directory.\");",
    "  let token = \"\";",
    "  try {",
    "    token = fs.readFileSync(resolved, \"utf8\").trim();",
    "    if (!/^\\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) fail(\"That does not look like a Telegram BotFather token.\");",
    "    const secretName = secretNameFor(label);",
    "    const stored = runOpenClaw([\"secrets\", \"store\", \"set\", secretName, \"--kind\", \"secret\"], { input: token + \"\\n\" });",
    "    if (stored.status !== 0) { const detail = [stored.stdout || \"\", stored.stderr || \"\"].join(\"\\n\").split(token).join(\"[REDACTED]\").trim(); fail(\"OpenClaw secret-store write failed: \" + detail.slice(0, 1200)); }",
    "    const registry = loadRegistry(); registry.version = 1; registry.entries ??= {};",
    "    const old = registry.entries[label] || {};",
    "    registry.entries[label] = { secretName, kind: \"telegram-bot-token\", storedAt: new Date().toISOString(), boundAccountId: old.boundAccountId || null, boundAgentId: old.boundAgentId || null };",
    "    saveRegistry(registry);",
    "    process.stdout.write(JSON.stringify({ ok: true, label, secretName, stored: true }) + \"\\n\");",
    "  } finally { token = \"\"; try { fs.unlinkSync(resolved); } catch {} }",
    "}",
    "",
    "function list() { process.stdout.write(JSON.stringify(loadRegistry(), null, 2) + \"\\n\"); }",
    "",
    "function bind(rawLabel, rawAccountId, rawAgentId) {",
    "  const label = normalizeLabel(rawLabel); const accountId = normalizeLabel(rawAccountId || label); const agentId = String(rawAgentId || label).trim();",
    "  const registry = loadRegistry(); const entry = registry.entries?.[label]; if (!entry?.secretName) fail(\"No deposited token found for label: \" + label);",
    "  if (!fs.existsSync(configPath)) fail(\"OpenClaw config not found.\");",
    "  const original = fs.readFileSync(configPath, \"utf8\"); const cfg = JSON.parse(original); if (!cfg.agents?.entries?.[agentId]) fail(\"Unknown agent id: \" + agentId);",
    "  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); const stamp = new Date().toISOString().replace(/[:.]/g, \"-\"); const backupPath = path.join(backupDir, stamp + \"-openclaw.json.pre-bind\"); fs.writeFileSync(backupPath, original, { encoding: \"utf8\", mode: 0o600 });",
    "  cfg.channels ??= {}; cfg.channels.telegram ??= {}; cfg.channels.telegram.accounts ??= {}; cfg.channels.telegram.accounts[accountId] ??= {}; cfg.channels.telegram.accounts[accountId].botToken = { source: \"store\", provider: \"default\", id: entry.secretName };",
    "  cfg.bindings ??= []; const already = cfg.bindings.some((b) => b?.agentId === agentId && b?.match?.channel === \"telegram\" && b?.match?.accountId === accountId); if (!already) cfg.bindings.push({ agentId, match: { channel: \"telegram\", accountId } });",
    "  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + \"\\n\", { encoding: \"utf8\", mode: 0o600 });",
    "  const validation = runOpenClaw([\"config\", \"validate\", \"--json\"]);",
    "  if (validation.status !== 0) { fs.copyFileSync(backupPath, configPath); const detail = [validation.stdout || \"\", validation.stderr || \"\"].join(\"\\n\").trim(); fail(\"Binding config rejected; restored backup. \" + detail.slice(0, 1200)); }",
    "  registry.entries[label] = { ...entry, boundAccountId: accountId, boundAgentId: agentId, boundAt: new Date().toISOString() }; saveRegistry(registry);",
    "  const reload = runOpenClaw([\"secrets\", \"reload\", \"--json\"]);",
    "  process.stdout.write(JSON.stringify({ ok: true, label, accountId, agentId, secretName: entry.secretName, configValid: true, secretsReloadRequested: reload.status === 0 }) + \"\\n\");",
    "}",
    "",
    "const [command, a, b, c] = process.argv.slice(2);",
    "if (command === \"deposit\") deposit(a, b); else if (command === \"list\") list(); else if (command === \"bind\") bind(a, b, c); else fail(\"Usage: telegram-token-vault.mjs deposit <label> <intake-file> | list | bind <label> <account-id> <agent-id>\", 2);",
    "",
  ].join("\n");

  const skill = [
    "---",
    "name: telegram-token-deposit",
    "description: Owner-only workflow for depositing Telegram BotFather tokens into Jarvis's OpenClaw secret store without browser configuration.",
    "user-invocable: true",
    "---",
    "",
    "# Telegram token deposit",
    "",
    "Use only for the owner's direct Jarvis session. Never use this workflow for another sender or in a shared/group conversation.",
    "",
    "The owner may invoke this skill with one token or several lines.",
    "Examples:",
    "- /telegram-token-deposit Forum 1 <BOT_TOKEN>",
    "- /telegram-token-deposit counsel-02 <BOT_TOKEN>",
    "- Multiple lines: label = <BOT_TOKEN>",
    "",
    "For each token:",
    "1. Parse the human label and token. Never repeat the token in the reply.",
    "2. Never write the token to MEMORY.md, daily memory, USER.md, AGENTS.md, logs, notes, registry JSON, or any long-lived file.",
    "3. Create a unique temporary file under /data/workspace/.secret-intake/ containing only the token.",
    "4. Restrict the temporary file to mode 0600.",
    "5. Execute: node /data/workspace/control/telegram-token-vault.mjs deposit <label> <temporary-file>",
    "6. The vault script validates the token, sends it to OpenClaw secrets store through stdin, updates a metadata-only registry, and deletes the temporary plaintext file.",
    "7. On success, tell the owner only the normalized label and secret name. Never echo the token.",
    "8. If one of several deposits fails, continue with the others and report only which label failed.",
    "9. Do not bind a deposited token unless the owner explicitly asks to bind it or the mapping has already been explicitly established.",
    "10. Later binding never requires the token again. Use: node /data/workspace/control/telegram-token-vault.mjs bind <label> <account-id> <agent-id>",
    "11. To show deposited labels, use: node /data/workspace/control/telegram-token-vault.mjs list",
    "",
    "Natural-language triggers include: deposit Telegram, store these Telegram tokens, put these bot keys in the vault.",
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, vaultScript, { encoding: "utf8", mode: 0o700 });
  fs.writeFileSync(skillPath, skill, { encoding: "utf8", mode: 0o600 });

  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, entries: {} }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  const marker = "## Jarvis Secret Deposit v1";
  const policy = [
    marker,
    "",
    "- Telegram bot tokens and similar credentials go to the OpenClaw shared secret store, not memory files.",
    "- When the owner asks to deposit Telegram tokens, use the telegram-token-deposit skill.",
    "- Never repeat a deposited secret or copy it into MEMORY.md, daily notes, USER.md, AGENTS.md, or the metadata registry.",
    "- Deposit and binding are separate. A token can be stored once and rebound later without asking the owner to paste it again.",
    "- Only Jarvis/main may perform this intake workflow. Adviser and research workspaces do not receive the deposit skill.",
    "",
  ].join("\n");

  if (fs.existsSync(agentsPath)) {
    let agents = fs.readFileSync(agentsPath, "utf8");
    const count = (agents.match(/## Jarvis Secret Deposit v1/g) || []).length;
    if (count === 0) fs.writeFileSync(agentsPath, agents.trimEnd() + "\n\n" + policy, { encoding: "utf8", mode: 0o600 });
    else if (count > 1) throw new Error("duplicate Jarvis Secret Deposit v1 markers found");
  }

  if (!fs.existsSync(scriptPath) || !fs.existsSync(skillPath)) throw new Error("telegram token deposit installer verification failed");

  console.log("[telegram-deposit-v1] installed and verified");
  return { applied: true, scriptPath, skillPath, registryPath };
}
