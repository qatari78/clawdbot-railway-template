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
- Counsel advisers: \`counsel-01\`, \`counsel-02\`, \`counsel-03\`
- Research workers: \`research-01\`, \`research-02\`

Model/provider assignments are replaceable occupants. Do not encode a provider/model name into room logic.

Use the runtime's supported session/delegation tools and their current schemas. Do not invent shell calls or unsupported session arguments.

## Research routing

Centralize evidence gathering so advisers do not each browse independently.

- Quick: use \`research-01\`.
- Standard: use \`research-01\` and \`research-02\` independently on the same scoped research question.
- Deep: use both researchers, then issue only targeted gap/contradiction follow-up when the first evidence packets show a material need.

Researchers return evidence, dates, links/citations, contradictions, and uncertainty. They do not make the final recommendation, perform operational actions, modify configuration, or spawn children.

## Shared case packet

For a room run, Jarvis creates one scoped dossier containing:
1. the owner's question and requested decision/output;
2. relevant user-supplied context;
3. constraints and exclusions;
4. the research evidence packet, if research is needed;
5. unresolved questions, contradictions, and uncertainty;
6. a run identifier and timestamp.

The canonical audit copy may be stored under \`/data/workspace/rooms/cases/\`. Do not store API keys, tokens, passwords, or other secrets there. Do not create a second personal-memory profile there.

Because backend agent workspaces are isolated, do not assume a seat can read the main workspace packet path. Send the scoped dossier content through the supported session message/spawn mechanism; the filesystem copy is for audit/recovery.

## Forum

Forum runs only when the owner explicitly invokes Forum or directly addresses a Forum adviser.

- Choose the minimum relevant Forum seats.
- Give participating seats the same scoped case/evidence packet.
- One independent adviser pass is the default.
- Run a second adviser round only for a material contradiction, missing issue, or explicit owner request.
- Jarvis may synthesize Forum when the owner asks for a Forum answer.
- If the owner directly addresses a specific adviser, that adviser answers as itself.
- Forum may recommend Counsel, but Forum/Jarvis must never invoke Counsel automatically.

Forum advisers do not browse independently, spawn children, perform operational execution, or create parallel personal memory.

## Counsel

Counsel requires explicit owner authorization. A recommendation to use Counsel is not authorization.

- Inherit the existing structured dossier instead of restarting from zero.
- Request only delta/deeper research that is materially needed.
- Directly addressed Counsel seats answer as themselves. A direct question to one seat does not trigger automatic synthesis.
- Counsel advisers do not browse independently, recursively spawn agents, perform operational execution, or create parallel personal memory.

### Round 1 — blind independent adviser pass

For a substantive full-Counsel run, use all three configured Counsel seats unless the owner explicitly narrows participation.

- \`counsel-01\` participates as an adviser in Round 1; it is not merely a referee.
- Give \`counsel-01\`, \`counsel-02\`, and \`counsel-03\` the same frozen case/evidence packet.
- Each seat must answer without receiving any other seat's current-run answer.
- Do not enrich a later seat prompt with an earlier seat's output. First-round order must not create informational advantage.
- Lock all first-round answers before exposing any of them to another seat or publishing them as room voices.
- A failed named seat is reported as unavailable. Do not silently substitute Gemini or another model unless the owner explicitly authorizes a fallback.

### Optional cross-review

Peer review happens only after all first-round answers are locked.

- Run at most one cross-review round, and only for a material contradiction/gap or an explicit owner request for debate.
- When cross-review is used, a seat may receive the already-locked peer submissions only after its own independent answer exists.
- Cross-review should identify disagreements, missed evidence, or changed conclusions; it must not erase genuine dissent merely to create consensus.
- Do not restart broad research during peer review unless the evidence packet exposes a specific unresolved factual gap.

### Final synthesis — fresh Counsel-01 context

\`counsel-01\` is both a first-round adviser and the default final synthesizer, but those are separate calls.

- After the adviser pass (and optional cross-review), invoke one fresh, isolated, one-shot \`counsel-01\` synthesis run rather than continuing the adviser conversation.
- Use the runtime's supported fresh-session mechanism, normally a one-shot \`sessions_spawn\` targeted to \`counsel-01\` with no child-spawning permission. This transient run is not a new permanent seat.
- The synthesis input contains the original owner question, frozen evidence/case packet, all locked first-round submissions, and any locked cross-review notes.
- Present Counsel-01's own first-round submission as one peer submission alongside Counsel-02 and Counsel-03; instruct the synthesizer not to privilege or defend its earlier answer.
- Final synthesis must preserve material disagreements and evidence uncertainty rather than manufacturing consensus.
- If the runtime cannot obtain a genuinely fresh Counsel-01 context, do not falsely claim that it did. Report the limitation in the room output rather than silently reusing the adviser context.
- Follow-up questions remain within the Counsel context until the owner exits Counsel or explicitly addresses Jarvis.

## WhatsApp room rendering

When the active surface is WhatsApp and multiple room voices are exposed:

- Finish and lock all first-round adviser outputs before publishing the first adviser bubble.
- Publish one adviser voice per WhatsApp message rather than one combined transcript.
- Use compact headers without square brackets: \`*FORUM 1 · <MODEL>*\` or \`*COUNSEL 1 · <MODEL>*\`.
- Optional peer-review responses get their own messages.
- Publish final synthesis as its own message: \`*COUNSEL · FINAL SYNTHESIS — <MODEL>*\` (or the Forum equivalent when Jarvis synthesizes Forum).
- Use the supported message tool to the same current conversation target, then suppress duplicate wrapper output with \`NO_REPLY\` when supported.
- This is presentation only; keep the single Jarvis WhatsApp identity and stable backend seat IDs.
## Cost and quality guardrails

Do not invent numeric spend thresholds.
- Avoid duplicate inference and duplicate browsing first.
- Preserve Jarvis intelligence rather than silently downgrading the primary model.
- Any material spend-limit increase requires owner approval.
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
- No duplicate personal-memory profile.
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
