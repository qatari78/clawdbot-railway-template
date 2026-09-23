import fs from "node:fs";
import path from "node:path";

const ADVISER_IDS = [
  "forum-01", "forum-02", "forum-03",
  "counsel-01", "counsel-02", "counsel-03",
];
const CANARY = "ADVISER_PRIVATE_CANARY_V1_COBALT_ORBIT_7421";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelText(entry) {
  return JSON.stringify({
    name: entry?.name,
    identity: entry?.identity,
    model: entry?.model,
  }).toLowerCase();
}

function parseJsonLoose(output) {
  const text = String(output || "").trim();
  try { return JSON.parse(text); } catch {}
  const starts = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{" || text[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  return null;
}

export async function runJarvisAdviserMemoryCommissioningV1({
  workspaceDir,
  configPath,
  runCmd,
  clawArgs,
  openclawNode,
}) {
  const diagnosticsDir = path.join(workspaceDir, "diagnostics");
  const resultPath = path.join(diagnosticsDir, "adviser-memory-commissioning-v1.json");
  fs.mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(resultPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      if (prior?.pass === true) {
        console.log("[adviser-memory-test-v1] prior passing result exists; skipping");
        return { ran: false, reason: "already-passed", resultPath };
      }
    } catch {}
  }

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entries = cfg.agents?.entries ?? {};
  const existing = ADVISER_IDS.filter((id) => Boolean(entries[id]));
  const forumFable = existing.find(
    (id) => id.startsWith("forum-") && modelText(entries[id]).includes("fable"),
  );
  const anyFable = existing.find((id) => modelText(entries[id]).includes("fable"));
  const target = forumFable || anyFable || existing.find((id) => id.startsWith("forum-")) || existing[0];
  if (!target) {
    throw new Error("No permanent adviser seat exists for memory commissioning");
  }
  const control =
    existing.find((id) => id.startsWith("forum-") && id !== target) ||
    existing.find((id) => id !== target);
  if (!control) {
    throw new Error("Need a second permanent adviser seat for isolation commissioning");
  }

  const startedAt = new Date().toISOString();
  const steps = [];
  const record = (name, data) => {
    const item = { name, ...data };
    steps.push(item);
    console.log("[adviser-memory-test-v1] " + JSON.stringify(item));
    return item;
  };

  const run = async (args, timeoutMs = 150_000) => {
    const result = await runCmd(openclawNode, clawArgs(args), { timeoutMs });
    return {
      code: result.code,
      output: String(result.output || ""),
      json: parseJsonLoose(result.output),
    };
  };

  const agentTurn = async (agentId, message, timeoutMs = 150_000) =>
    run(["agent", "--agent", agentId, "--message", message, "--json"], timeoutMs);

  const memorySearch = async (agentId, query) =>
    run(["memory", "search", query, "--agent", agentId, "--json"], 120_000);

  const tell = await agentTurn(
    target,
    [
      "Commissioning memory test for this permanent adviser seat.",
      "Treat this harmless statement as a durable private adviser memory:",
      CANARY,
      "It names a fictional cobalt notebook used only to verify your own continuity.",
      "Acknowledge briefly. Do not send it to another adviser and do not write it into Jarvis shared memory.",
    ].join(" "),
  );
  record("tell-target", {
    agentId: target,
    ok: tell.code === 0,
    canarySeenInResponse: tell.output.includes(CANARY),
  });

  const reset = await agentTurn(target, "/new");
  record("new-target-session", {
    agentId: target,
    ok: reset.code === 0,
  });

  let indexedTarget = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    indexedTarget = await memorySearch(target, CANARY);
    if (indexedTarget.code === 0 && indexedTarget.output.includes(CANARY)) break;
    await sleep(2000);
  }
  record("target-index-after-new", {
    agentId: target,
    ok: indexedTarget?.code === 0 && indexedTarget.output.includes(CANARY),
  });

  const recall = await agentTurn(
    target,
    "What exact private commissioning phrase did I tell you before the session reset? Reply with the exact phrase only if you remember it from your own prior interaction; otherwise reply UNKNOWN.",
  );
  record("target-recall-after-new", {
    agentId: target,
    ok: recall.code === 0 && recall.output.includes(CANARY),
    canarySeen: recall.output.includes(CANARY),
  });

  const controlSearch = await memorySearch(control, CANARY);
  record("control-index-isolation", {
    agentId: control,
    ok: controlSearch.code === 0 && !controlSearch.output.includes(CANARY),
    canarySeen: controlSearch.output.includes(CANARY),
  });

  const controlReply = await agentTurn(
    control,
    `A private commissioning phrase was told to another adviser seat (${target}), not to you. Without guessing or asking another adviser, do you personally remember that exact phrase from your own durable memory? Reply exactly UNKNOWN if it is not in your own memory.`,
  );
  record("control-model-isolation", {
    agentId: control,
    ok: controlReply.code === 0 && /UNKNOWN/i.test(controlReply.output) && !controlReply.output.includes(CANARY),
    canarySeen: controlReply.output.includes(CANARY),
    unknownSeen: /UNKNOWN/i.test(controlReply.output),
  });

  let jobs = null;
  let dreamJob = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    jobs = await run(["automations", "list", "--all", "--json"], 60_000);
    const payload = jobs.json;
    const candidates = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.jobs) ? payload.jobs : []);
    dreamJob = candidates.find((job) =>
      /Memory Dreaming Promotion/i.test(String(job?.name || "")) ||
      /memory-core\.short-term-promotion/i.test(JSON.stringify(job)),
    );
    if (dreamJob?.id) break;
    await sleep(2000);
  }
  record("dreaming-job-present", {
    ok: jobs?.code === 0 && Boolean(dreamJob?.id),
    jobName: dreamJob?.name ?? null,
  });

  let dreamRun = null;
  if (dreamJob?.id) {
    dreamRun = await run(
      [
        "automations", "run", String(dreamJob.id),
        "--wait",
        "--wait-timeout", "5m",
        "--poll-interval", "2s",
        "--json",
      ],
      330_000,
    );
  }
  const dreamOutput = dreamRun?.output || "";
  record("dreaming-forced-sweep", {
    ok: dreamRun?.code === 0 &&
      !/"completionStatus"\s*:\s*"(failed|unknown)"/i.test(dreamOutput),
    exitCode: dreamRun?.code ?? null,
  });

  const postDreamSearch = await memorySearch(target, CANARY);
  record("target-memory-after-dreaming", {
    agentId: target,
    ok: postDreamSearch.code === 0 && postDreamSearch.output.includes(CANARY),
    canarySeen: postDreamSearch.output.includes(CANARY),
  });

  const postDreamControl = await memorySearch(control, CANARY);
  record("control-isolation-after-dreaming", {
    agentId: control,
    ok: postDreamControl.code === 0 && !postDreamControl.output.includes(CANARY),
    canarySeen: postDreamControl.output.includes(CANARY),
  });

  const postDreamRecall = await agentTurn(
    target,
    "After the memory consolidation sweep, what exact private commissioning phrase did I tell you earlier? Reply with the exact phrase only if it remains in your own memory; otherwise reply UNKNOWN.",
  );
  record("target-recall-after-dreaming", {
    agentId: target,
    ok: postDreamRecall.code === 0 && postDreamRecall.output.includes(CANARY),
    canarySeen: postDreamRecall.output.includes(CANARY),
  });

  const required = [
    "tell-target",
    "new-target-session",
    "target-index-after-new",
    "target-recall-after-new",
    "control-index-isolation",
    "control-model-isolation",
    "dreaming-job-present",
    "dreaming-forced-sweep",
    "target-memory-after-dreaming",
    "control-isolation-after-dreaming",
    "target-recall-after-dreaming",
  ];
  const pass = required.every((name) => steps.find((step) => step.name === name)?.ok === true);

  const summary = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    target,
    targetDetectedAsForumFable: target === forumFable,
    targetDetectedAsFable: target === forumFable || target === anyFable,
    control,
    canary: CANARY,
    steps,
    pass,
  };

  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(resultPath, 0o600); } catch {}

  console.log("[adviser-memory-test-v1] completed " + JSON.stringify({
    pass,
    target,
    targetDetectedAsForumFable: summary.targetDetectedAsForumFable,
    control,
    failedSteps: steps.filter((step) => !step.ok).map((step) => step.name),
  }));

  return { ran: true, resultPath, pass, target, control };
}
