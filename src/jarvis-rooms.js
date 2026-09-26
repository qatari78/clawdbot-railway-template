import fs from "node:fs";
import path from "node:path";

const MANAGED_MARKER = "<!-- managed-by: jarvis-rooms-v1 -->";

function backupOnce(src, backupDir, name) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dst = path.join(backupDir, name);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}

function writeManagedFile(filePath, body, backupDir, backupName) {
  const normalized = body.trimEnd() + "\n";
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === normalized) return false;
    backupOnce(filePath, backupDir, backupName);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, normalized, { encoding: "utf8", mode: 0o600 });
  return true;
}

export function installJarvisRoomsV1(workspaceDir) {
  if (process.env.JARVIS_ROOMS_V1?.trim() !== "1") {
    return { applied: false, reason: "disabled" };
  }

  const backupDir = path.join(
    workspaceDir,
    "memory",
    ".seed-backups",
    "2026-09-22-jarvis-rooms-v1",
  );
  const skillPath = path.join(workspaceDir, "skills", "jarvis-rooms", "SKILL.md");
  const roomsReadmePath = path.join(workspaceDir, "rooms", "README.md");

  const skill = `---
name: jarvis-rooms
description: Run Jarvis Forum, Counsel, and centralized research using the installed stable backend seats.
user-invocable: false
---

# Jarvis Rooms v1

<!-- managed-by: jarvis-rooms-v1 -->

## Default mode

Jarvis stays direct-first. Normal questions and deterministic tool work are handled by Jarvis without creating an agent workflow merely because a task is difficult.

Long research or room work should be delegated to backend sessions so the main Jarvis conversation remains available while specialist work proceeds.

## Stable backend seats

Use only the already-installed stable agent IDs:
- Forum advisers: \`forum-01\`, \`forum-02\`, \`forum-03\`
- Active Counsel advisers: \`counsel-01\`, \`counsel-02\`
- \`counsel-03\` is intentionally OPEN and must not be dispatched until the owner fills/activates it.
- Research workers: \`research-01\`, \`research-02\`

Model/provider assignments are replaceable occupants. Do not encode a provider/model name into room logic.

Use the runtime's supported session/delegation tools and their current schemas. Do not invent shell calls or unsupported session arguments.

## Research routing

Use Jarvis Research System v1.1 as the shared evidence service for both rooms.

- None: reasoning/writing where current factual investigation is unnecessary.
- Lookup: one or two checkable facts through the read-only lookup path.
- Verifier-only: one specific document or source.
- Dual (default whenever a room question needs research): the Verifier and the Scout research the same de-identified neutral brief concurrently and independently. They must not see each other's work, earlier conclusions, adviser views, or a shared sub-question plan.
- Heavy: both with deeper budgets for high stakes, exhaustive maps, multiple long documents, or unresolved material contradictions.
- HOW to run research (every level, every room): only through the research runner — write the neutral brief as JSON and run \`node /app/src/jarvis-research-runner.js run <brief.json> <verifier|dual|heavy>\`; for a seat's RESEARCH NEEDED use \`node /app/src/jarvis-research-gap.js <gap-request.json>\`. Start it (exec with yieldMs 1200000 and timeoutSeconds 1500) and wait for it with as few checks as possible — each check that returns \"still waiting\" re-sends your whole working context and costs money (26 Sep: about $0.13 a check); never poll in a short loop. Tell the owner research is running if it takes more than a minute. The runner has search, tool budgets and time limits built in (measured 26 Sep: a dual run ≈ $0.27 and 4 minutes). It already retries a researcher that failed for a passing reason, so never run it again for the same brief: if its summary says \`partial: true\`, one researcher failed even after the retry — continue with the dossier it produced and tell the owner which researcher failed; if it failed completely, tell the owner what failed and ask whether to continue without research. Never spawn research-01 or research-02 as sub-agents: they have no search engine there and are slow, and waiting for them cost ≈ $10 in 12 minutes of status checks.
- When spawning Forum or Counsel seats, pass runTimeoutSeconds equal to the wait limit (Forum 480, Counsel 1200). While seats or research run, wait with the longest waits available instead of frequent status checks; every check is a paid model call.
- Primary researchers are stateless: skills and shared evidence/cache persist; personal researcher memory does not.

Research output goes to the append-only evidence ledger and compact active dossier. Researchers return typed evidence, dates, citations/locators, source lineage, contradictions, uncertainty, and open questions. They do not make the final recommendation, perform operational actions, modify configuration, or spawn children.

Adviser gaps go through the Research Gap Service: verify/read-document -> Verifier; find-missing/find-contrary/enumerate -> Scout; social -> X helper; calculate -> deterministic computation from verified ledger claims. Check the ledger before new research.

## Shared case packet

For a room run, Jarvis creates one scoped dossier containing:
1. the owner's question and requested decision/output;
2. relevant user-supplied context;
3. constraints and exclusions;
4. the research evidence packet, if research is needed;
5. unresolved questions, contradictions, and uncertainty;
6. a run identifier and timestamp.

The canonical audit copy may be stored under \`/data/workspace/rooms/cases/\`. Do not store API keys, tokens, passwords, or other secrets there. Room case folders are task-scoped audit artifacts, not an adviser memory namespace.

Because backend agent workspaces are isolated, do not assume a seat can read the main workspace packet path. Send the scoped dossier content through the supported session message/spawn mechanism; the filesystem copy is for audit/recovery.

## Forum

Forum runs only when the owner explicitly invokes Forum or directly addresses a Forum adviser. A message that starts with "Forum:" is an explicit invocation: run the full Forum below even when the question looks simple; length or format instructions in the question apply to the seats' answers.

- For a substantive full-Forum run, use all three configured Forum seats unless the owner explicitly narrows participation.
- Jarvis prepares the shared case/evidence packet, commissions centralized research when needed, and orchestrates the room.
- Give participating Forum seats the same frozen scoped case/evidence packet.
- Each participating seat produces an independent first-round adviser answer without seeing another seat's current-run answer.
- Lock all first-round adviser answers before exposing any of them to another seat or publishing them as room voices.
- Never start a second round automatically. A second round (debate / cross-review / "read each other") runs only when the owner commands it.
- If the owner directly addresses a specific adviser, that adviser answers as itself; a direct single-seat question does not automatically trigger full-room synthesis.
- Forum may recommend Counsel, but Forum/Jarvis must never invoke Counsel automatically.

### Synthesis

- No Forum seat is permanently the chair, chief, or synthesizer. Seat numbers are identity/memory/channel slots only.
- Synthesis happens only when the owner commands it. Never synthesize automatically.
- Forum synthesizer: Jarvis. When the owner says "synthesize" (or similar) without naming anyone, Jarvis writes the Forum synthesis itself from the locked answers — never hand it to a Forum seat. Only when the owner names a seat or model for that run does that seat/model synthesize.
- When a named Forum seat synthesizes after also advising, use a fresh isolated synthesis context and provide the frozen case/evidence packet plus all locked submissions. Its earlier adviser answer is one peer submission, not privileged.
- Final synthesis must preserve material disagreements and evidence uncertainty rather than manufacturing consensus.
- The synthesizer may change from run to run without changing any permanent seat identity, memory, or Telegram binding.

Forum advisers do not browse independently, spawn children, or perform operational execution. Each permanent Forum adviser keeps its own durable adviser memory; it must not claim another adviser's private memory as its own.

## Counsel

Counsel requires explicit owner authorization. A recommendation to use Counsel is not authorization.

A message that starts with "Counsel:" (or asks for Counsel by name, e.g. "ask Counsel …") IS that authorization: run the owner-defined Counsel protocol below in full — research, the seats' blind first answers, the bundle — even when the question looks simple or asks for short answers. The owner wants the seats' views, not a direct answer from Jarvis; length or format instructions in the question apply to the seats' answers. Answer directly only if the owner says so.

- Inherit the existing structured dossier instead of restarting from zero.
- Request only delta/deeper research that is materially needed.
- Directly addressed Counsel seats answer as themselves. A direct question to one seat does not trigger automatic synthesis.
- Counsel advisers do not receive unrestricted browser/web tools, recursively spawn agents, or perform operational execution. Opus/Astra may steer bounded evidence_search/evidence_fetch through the shared Research Gap Service; resulting evidence is written to the common ledger. Each permanent Counsel adviser keeps its own durable adviser memory and must not claim another adviser's private memory as its own.

### Owner-defined Counsel protocol (2026-09-26) — follow exactly

1. Research first. Build the dossier; commission research (Dual by default when the question needs evidence).
2. Send every active Counsel seat the same frozen dossier + research pack. In the same message, tell each seat: "If you need more evidence before answering, reply RESEARCH NEEDED with specific questions; otherwise give your first answer."
3. If any seat asks for research, run it through the researchers (seats never browse), then send the new evidence to ALL active Counsel seats and collect first answers. One extra research round per run unless the owner asks for more.
4. First answers are blind: no Forum material and no other Counsel answer before a seat's own first answer is locked.
5. After all first answers are locked, Jarvis assembles the shared bundle: each Forum member's individual answer, the Forum synthesis (if one exists), and every Counsel member's first answer. Tell the owner the bundle is ready. Do NOT start a second round.
6. Second round only on the owner's command (e.g. "debate", "read each other", "second round"): each Counsel seat receives the shared bundle and writes its second iteration.
7. Synthesis only on the owner's command, by the Counsel member the owner names, in a fresh isolated context with the dossier and all submissions.
8. Jarvis's role in Counsel: read /data/workspace/reports/lineup.json. If "jarvisCounselRole" is "clerk-only" (Jarvis's model comes from a company already seated in Counsel), Jarvis only runs the steps and relays — no view, no synthesis.

Wait limits (never silence): Forum seat 8 min; Counsel seat 20 min; research quick 10 min, deep 30 min. If a seat or researcher exceeds its limit, report "<seat> timed out" to the owner and continue with the others.

### Round 1 — blind independent adviser pass

For a substantive full-Counsel run, use every active Counsel seat unless the owner explicitly narrows participation. Counsel 3 must not run while it is intentionally OPEN.

- \`counsel-01\` participates as an adviser in Round 1; it is not merely a referee.
- Give every active Counsel seat the same frozen dossier/evidence packet. Never dispatch an OPEN seat.
- Each seat must answer without receiving any other seat's current-run answer.
- Do not enrich a later seat prompt with an earlier seat's output. First-round order must not create informational advantage.
- Lock all first-round answers before exposing any of them to another seat or publishing them as room voices.
- A failed named seat is reported as unavailable. Do not silently substitute Gemini or another model unless the owner explicitly authorizes a fallback.

### Optional cross-review

Peer review happens only after all first-round answers are locked.

- Never start cross-review automatically; it runs only on the owner's command (step 6 above).
- When cross-review is used, a seat may receive the already-locked peer submissions only after its own independent answer exists.
- Cross-review should identify disagreements, missed evidence, or changed conclusions; it must not erase genuine dissent merely to create consensus.
- Do not restart broad research during peer review unless the evidence packet exposes a specific unresolved factual gap.

### Synthesis

- No Counsel seat is permanently the chair, chief, or synthesizer. Seat numbers are identity/memory/channel slots only.
- Synthesis happens only when the owner commands it, by the Counsel member the owner names for that run.
- When a Counsel participant is used as synthesizer after also advising, use a fresh isolated synthesis context and provide the frozen dossier, all locked adviser submissions, and any locked cross-review notes. Its earlier adviser answer is one peer submission, not privileged.
- Final synthesis must preserve material disagreements and evidence uncertainty rather than manufacturing consensus.
- The synthesizer may change from run to run without changing any permanent seat identity, memory, or Telegram binding.
- Follow-up questions remain within the Counsel context until the owner exits Counsel or explicitly addresses Jarvis.

## Channel delivery and seat identity

- Stable seat IDs are the canonical identities. Current model/provider names are replaceable occupant metadata and must never be encoded as the identity or orchestration role.
- Telegram bindings are seat-level bindings. Swapping the model behind a seat must not require changing that seat's Telegram bot/account binding.
- On Telegram, when a participating adviser seat has its own bound Telegram bot/account, that seat publishes its own adviser output directly under that Telegram identity using the Telegram accountId that matches the stable seat ID. Jarvis must not re-voice the same output as though Jarvis authored it.
- On Telegram, if the selected synthesizer is a bound room seat, that seat publishes the synthesis/artifact under its own Telegram identity. If synthesis is performed by a non-seat model or by Jarvis, delivery must clearly identify the actual synthesizer; never attribute synthesis to a numbered seat that did not produce it.
- If a required Telegram seat has not yet been bound to a bot/account, do not impersonate it. The backend seat may still run, but disclose that direct Telegram delivery for that seat is pending.
- On WhatsApp, the single linked identity remains Jarvis. Jarvis transports room outputs, but attributes each adviser message and final synthesis to the permanent seat that authored it. Transport through Jarvis does not make Jarvis the intellectual author.
- Channel choice changes only delivery, never authorship, seat memory, adviser order, or which seat performs final synthesis.
## WhatsApp room rendering

When the active surface is WhatsApp and multiple room voices are exposed:

- Publish each adviser's first-round answer to the owner as soon as that adviser finishes (do not wait for the slowest seat). Seats still never see each other's answers until the owner commands a second round.
- Take current model names for headers from /data/workspace/reports/lineup.json (configured seat models), not from memory.
- Publish one adviser voice per WhatsApp message rather than one combined transcript.
- Use compact headers without square brackets: \`*FORUM 1 · <MODEL>*\` or \`*COUNSEL 1 · <MODEL>*\`.
- Optional peer-review responses get their own messages.
- Publish final synthesis as its own message and identify the actual synthesizing model/seat for that run. Do not imply that any numbered seat has permanent synthesis authority.
- Use the supported message tool to the same current conversation target, then suppress duplicate wrapper output with \`NO_REPLY\` when supported.
- This is presentation only; keep the single Jarvis WhatsApp identity and stable backend seat IDs.
## Cost and quality guardrails

- Do not impose Jarvis-specific dollar spending caps or output-token ceilings. The owner's prepaid balance is the financial guardrail.
- Use search-count, page-read, wall-clock and loop breakers only to stop pathological loops, not to cheapen normal research.
- Avoid duplicate inference and duplicate browsing first.
- Preserve Jarvis intelligence rather than silently downgrading the primary model.
- Any routing change that materially reduces quality requires owner approval.
- New model/provider assignments belong in replaceable seat configuration, not in this skill.

## Operational delegation

Research/adviser seats are not operator agents. Real-world account actions, deployments, configuration changes, social posting, finance operations, or similar execution go only to dedicated operator agents with explicit permissions once those agents exist.

## Failure behavior

Use the existing bounded recovery policy. If a worker fails repeatedly, change method or report the blocker; do not recursively spawn a herd of replacement agents.
`;

  const roomsReadme = `# Jarvis room workspace

<!-- managed-by: jarvis-rooms-v1 -->

This directory is for scoped Forum/Counsel case dossiers, research evidence packets, and room-run recovery/audit artifacts.

Recommended future layout:

\`rooms/cases/<run-id>/case.md\`
\`rooms/cases/<run-id>/evidence.md\`
\`rooms/cases/<run-id>/forum.md\`
\`rooms/cases/<run-id>/counsel.md\`

Rules:
- No API keys, bot tokens, passwords, provider credentials, or other secrets.
- Do not use this room directory as a duplicate personal-memory profile. Permanent adviser memory lives only in each adviser's own workspace.
- Jarvis's canonical memory remains the shared factual backbone; adviser-private memory remains seat-specific.
- Keep only task-scoped context needed for the room run.
- Backend seats may have isolated workspaces, so pass the scoped dossier through supported session messaging; do not rely on cross-workspace file access.
`;

  const changedSkill = writeManagedFile(skillPath, skill, backupDir, "SKILL.md.pre-v1");
  const changedReadme = writeManagedFile(roomsReadmePath, roomsReadme, backupDir, "rooms-README.md.pre-v1");

  const verifySkill = fs.readFileSync(skillPath, "utf8");
  const verifyReadme = fs.readFileSync(roomsReadmePath, "utf8");
  if (!verifySkill.includes(MANAGED_MARKER) || !verifySkill.includes("# Jarvis Rooms v1")) {
    throw new Error("jarvis-rooms skill verification failed");
  }
  if (!verifyReadme.includes(MANAGED_MARKER)) {
    throw new Error("jarvis-rooms README verification failed");
  }

  try { fs.chmodSync(skillPath, 0o600); } catch {}
  try { fs.chmodSync(roomsReadmePath, 0o600); } catch {}

  console.log("[jarvis-rooms-v1] installed and verified");
  return { applied: true, changed: changedSkill || changedReadme, skillPath, roomsReadmePath, backupDir };
}
