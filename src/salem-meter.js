import fs from "node:fs";
import path from "node:path";

// Salem AI smart meter (Claude, 2026-09-26) — C3 / C4 / G2.
//
// "Wire, don't build": every number comes from data OpenClaw and OpenRouter already keep.
//   - Model spend, tokens, latency, per-15-minute buckets: OpenClaw's own usage rollups
//     (gateway RPC `sessions.usage` / `usage.cost`), which record the provider-billed cost
//     OpenRouter returns with every call.
//   - Cross-check: the OpenRouter key's own cumulative usage, sampled every 5 minutes by the
//     money fuse (jarvis-spend-history.json).
//   - Prices and new model versions: OpenRouter's public model list.
// The only new idea is the task: one owner message to Jarvis = one task. Every model call
// (Jarvis, rooms, research) is charged to the owner's most recent message, at the 15-minute
// resolution OpenClaw keeps, so $/task is all-in (what one question really costs).
// Nothing here calls a model; nothing here changes a seat.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const QUARTER = 15 * 60 * 1000;
const QATAR_OFFSET_MS = 3 * HOUR; // Asia/Qatar is UTC+3 all year (no DST).

export const qatarDate = (ms = Date.now()) => new Date(ms + QATAR_OFFSET_MS).toISOString().slice(0, 10);
export const qatarDayStartMs = (dateStr) => Date.parse(`${dateStr}T00:00:00Z`) - QATAR_OFFSET_MS;
export const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const qatarHour = (ms = Date.now()) => new Date(ms + QATAR_OFFSET_MS).getUTCHours();
const qatarMinute = (ms = Date.now()) => new Date(ms + QATAR_OFFSET_MS).getUTCMinutes();
const qatarWeekday = (ms = Date.now()) => new Date(ms + QATAR_OFFSET_MS).getUTCDay(); // 0 = Sunday
const fmtClock = (ms) => new Date(ms + QATAR_OFFSET_MS).toISOString().slice(11, 16);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export const money = (n) => {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
};
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : "n/a");

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  if (v.length === 1) return v[0];
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

// ---- classification ------------------------------------------------------------------

// A task is one message from the owner in one of Jarvis's owner-facing chats.
export function isOwnerTaskSession(key) {
  const k = String(key || "");
  if (k.includes(":explicit:") || k.includes(":subagent:") || k.includes(":cron:")) return false;
  return /^agent:main:(whatsapp|telegram):(direct|group|dm|channel):/.test(k);
}

export function isTestSession(key) {
  return String(key || "").includes(":explicit:claude-test-");
}

// R11: a test session that has been deleted keeps its usage, but its row key loses the
// "claude-test" name (it becomes agent:<id>:<sessionId>). The test ledger lists those session
// ids (recorded by test.cleanup) and commissioning days, on which every session outside the
// owner's own chats and Jarvis's main session was a test. Returns (key, row) => boolean.
export function testMatcher(ledger) {
  const ids = new Set((ledger?.ids ?? []).map(String));
  const days = new Set((ledger?.days ?? []).map(String));
  return (key, row) => {
    const k = String(key || "");
    if (isTestSession(k)) return true;
    if (ids.size && ids.has(k.split(":").pop())) return true;
    if (days.size && !isOwnerTaskSession(k) && k !== "agent:main:main") {
      const buckets = row?.usage?.utcQuarterHourTokenUsage ?? [];
      if (buckets.some((b) => days.has(qatarDate(bucketMs(b))))) return true;
    }
    return false;
  };
}

export function roomOf(agentId) {
  const id = String(agentId || "");
  if (id === "main") return "Jarvis";
  if (id.startsWith("forum-")) return "Forum";
  if (id.startsWith("counsel-")) return "Counsel";
  if (id.startsWith("research-")) return "Research";
  return "Other";
}

export const SEAT_LABELS = {
  main: "Jarvis", "forum-01": "Forum 1", "forum-02": "Forum 2", "forum-03": "Forum 3",
  "counsel-01": "Counsel 1", "counsel-02": "Counsel 2", "counsel-03": "Counsel 3",
  "research-01": "Verifier", "research-02": "Scout",
};

export const shortModel = (m) => String(m || "?").replace(/^openrouter\//, "").replace(/^[^/]+\//, "");

// ---- pure computation -----------------------------------------------------------------

const bucketMs = (b) => Date.parse(`${b.date}T00:00:00Z`) + Number(b.quarterIndex || 0) * QUARTER;

// Build one day's meter from a `sessions.usage` result for that day.
// `windowStart`/`windowEnd` bound the day in epoch ms (Qatar calendar day).
export function computeDay(result, { windowStart, windowEnd, includeTests = false, isTest = (key) => isTestSession(key) } = {}) {
  const rows = (result?.sessions ?? []).filter((r) => includeTests || !isTest(r.key, r));
  const inWindow = (ms) => ms >= windowStart && ms < windowEnd;

  const taskBuckets = new Map(); // bucketMs -> owner messages
  const costBuckets = new Map(); // bucketMs -> cost (all agents)
  const byAgent = new Map();
  const byModelMap = new Map();
  const byAgentModel = new Map();
  let testCost = 0;
  const latency = { count: 0, sumMs: 0, p95Max: NaN };
  let maxToolCalls = 0;
  let errors = 0;

  for (const r of result?.sessions ?? []) {
    const u = r.usage;
    if (!u) continue;
    if (!includeTests && isTest(r.key, r)) {
      for (const b of u.utcQuarterHourTokenUsage ?? []) if (inWindow(bucketMs(b))) testCost += Number(b.totalCost) || 0;
      continue;
    }
    for (const mu of u.modelUsage ?? []) {
      const model = String(mu.model || "?");
      const cost = Number(mu.totals?.totalCost) || 0;
      const calls = Number(mu.count) || 0;
      if (cost <= 0 && model === "gateway-injected") continue;
      const m = byModelMap.get(model) ?? { model, provider: mu.provider, calls: 0, cost: 0 };
      m.calls += calls; m.cost += cost; byModelMap.set(model, m);
      const am = byAgentModel.get(r.agentId) ?? new Map();
      const e = am.get(model) ?? { model, calls: 0, cost: 0 };
      e.calls += calls; e.cost += cost; am.set(model, e); byAgentModel.set(r.agentId, am);
    }
    const a = byAgent.get(r.agentId) ?? { cost: 0, calls: 0 };
    for (const b of u.utcQuarterHourTokenUsage ?? []) {
      const t = bucketMs(b);
      if (!inWindow(t)) continue;
      const c = Number(b.totalCost) || 0;
      costBuckets.set(t, (costBuckets.get(t) ?? 0) + c);
      a.cost += c;
    }
    a.calls += Number(u.messageCounts?.assistant) || 0;
    if (a.cost > 0 || a.calls > 0) byAgent.set(r.agentId, a);
    maxToolCalls = Math.max(maxToolCalls, Number(u.messageCounts?.toolCalls) || 0);
    errors += Number(u.messageCounts?.errors) || 0;
    if (isOwnerTaskSession(r.key)) {
      for (const b of u.utcQuarterHourMessageCounts ?? []) {
        const t = bucketMs(b);
        const n = Number(b.user) || 0;
        if (n > 0 && inWindow(t)) taskBuckets.set(t, (taskBuckets.get(t) ?? 0) + n);
      }
      // OpenClaw's per-session latency also counts replies that are not model answers (e.g. a
      // report the wrapper delivered into the chat hours after the last message); a session
      // average above 10 minutes is not model time, so it is left out of the speed line.
      if (u.latency?.count && Number(u.latency.avgMs) <= 10 * 60 * 1000) {
        latency.count += u.latency.count;
        latency.sumMs += u.latency.avgMs * u.latency.count;
        latency.p95Max = Number.isFinite(latency.p95Max) ? Math.max(latency.p95Max, u.latency.p95Ms) : u.latency.p95Ms;
      }
    }
  }

  // Charge every cost bucket to the owner's most recent message at or before it.
  const taskTimes = [...taskBuckets.keys()].sort((x, y) => x - y);
  const perBucketCost = new Map(taskTimes.map((t) => [t, 0]));
  let background = 0;
  for (const [t, c] of [...costBuckets.entries()].sort((x, y) => x[0] - y[0])) {
    let owner = null;
    for (const tt of taskTimes) { if (tt <= t) owner = tt; else break; }
    if (owner === null) background += c; else perBucketCost.set(owner, perBucketCost.get(owner) + c);
  }
  const tasks = [];
  for (const t of taskTimes) {
    const n = taskBuckets.get(t);
    for (let i = 0; i < n; i += 1) tasks.push({ at: t, cost: perBucketCost.get(t) / n });
  }

  const totalCost = [...costBuckets.values()].reduce((s, c) => s + c, 0);
  const totals = result?.totals ?? {};
  const inputAll = (Number(totals.input) || 0) + (Number(totals.cacheRead) || 0) + (Number(totals.cacheWrite) || 0);
  const byModel = [...byModelMap.values()].filter((m) => m.cost > 0.0005).sort((a, b) => b.cost - a.cost);
  const rooms = {};
  for (const [agentId, a] of byAgent) rooms[roomOf(agentId)] = (rooms[roomOf(agentId)] ?? 0) + a.cost;

  return {
    totalCost,
    testCost,
    taskCount: tasks.length,
    perTask: {
      allIn: tasks.length ? (totalCost - background) / tasks.length : NaN,
      median: percentile(tasks.map((t) => t.cost), 0.5),
      p90: percentile(tasks.map((t) => t.cost), 0.9),
    },
    background,
    topTasks: tasks.slice().sort((a, b) => b.cost - a.cost).slice(0, 3),
    rooms,
    byAgent: Object.fromEntries([...byAgent.entries()].map(([k, v]) => [k, { cost: v.cost, calls: v.calls }])),
    byAgentModel: Object.fromEntries([...byAgentModel.entries()].map(([k, m]) => [k, [...m.values()].sort((x, y) => y.cost - x.cost)])),
    byModel,
    latency: { avgMs: latency.count ? latency.sumMs / latency.count : NaN, p95Ms: latency.p95Max, replies: latency.count },
    cacheHitRate: inputAll > 0 ? (Number(totals.cacheRead) || 0) / inputAll : NaN,
    missingCostEntries: Number(totals.missingCostEntries) || 0,
    maxToolCalls,
    errors,
  };
}

// R14: the research runner calls OpenRouter directly, outside OpenClaw's sessions, so session
// usage misses it (26 Sep: $0.25–0.85 per dual run). Synthetic usage rows built from the runner's
// run records let computeDay charge that cost like any other: by time, to the owner's message it
// served (or to commissioning tests on a marked day). One row per research seat — research-01
// (Verifier), research-02 (Scout) — plus "research-checks" (support checks, failed attempts).
// Runs marked test are skipped.
export function researchRunsRows(runs, windowStart, windowEnd) {
  const seatOf = (who) => (who === "verifier" ? "research-01" : who === "scout" ? "research-02" : "research-checks");
  const rows = new Map(); // agentId -> { buckets, models, count }
  const add = (agentId, t, model, cost, calls) => {
    if (!(cost > 0)) return;
    const r = rows.get(agentId) || { buckets: new Map(), models: new Map(), count: 0 };
    const date = new Date(t).toISOString().slice(0, 10);
    const k = `${date}|${Math.floor((t - Date.parse(`${date}T00:00:00Z`)) / QUARTER)}`;
    r.buckets.set(k, (r.buckets.get(k) || 0) + cost);
    const m = r.models.get(model) || { count: 0, cost: 0 };
    m.count += calls; m.cost += cost; r.models.set(model, m);
    r.count += calls;
    rows.set(agentId, r);
  };
  for (const s of runs || []) {
    if (!s || s.test === true) continue;
    const t = Date.parse(s.finished_at);
    const total = Number(s.total_cost_usd) || 0;
    if (!Number.isFinite(t) || t < windowStart || t >= windowEnd || total <= 0) continue;
    let modelled = 0;
    for (const x of s.telemetry || []) {
      const c = Number(x?.usage?.cost) || 0;
      modelled += c;
      add(seatOf(x?.researcher), t, String(x?.model || "?"), c, Number(x?.attempts) || 1);
    }
    if (total - modelled > 0.0005) add("research-checks", t, "support checks and failed attempts", total - modelled, 1);
  }
  return [...rows].map(([agentId, r]) => ({
    key: `agent:${agentId}:runner`,
    agentId,
    usage: {
      utcQuarterHourTokenUsage: [...r.buckets].map(([k, totalCost]) => { const [date, q] = k.split("|"); return { date, quarterIndex: Number(q), totalCost }; }),
      modelUsage: [...r.models].map(([model, m]) => ({ provider: "openrouter", model, count: m.count, totals: { totalCost: m.cost } })),
      messageCounts: { assistant: r.count, toolCalls: 0, errors: 0, user: 0 },
    },
  }));
}

// OpenRouter's own spend in [start, end) from cumulative key-usage samples.
export function openRouterSpend(samples, start, end) {
  const list = (samples || []).filter((s) => Number.isFinite(s?.t) && Number.isFinite(s?.usage)).sort((a, b) => a.t - b.t);
  if (list.length < 2) return { spend: NaN, coverage: "none" };
  const at = (t) => { let v = null; for (const s of list) { if (s.t <= t) v = s; else break; } return v; };
  const a = at(start);
  const b = at(end) ?? list[list.length - 1];
  const first = list[0];
  if (!a) {
    return { spend: Math.max(0, b.usage - first.usage), coverage: "partial", since: first.t };
  }
  return { spend: Math.max(0, b.usage - a.usage), coverage: end - b.t > 20 * 60 * 1000 ? "partial" : "full" };
}

// ---- rendering -----------------------------------------------------------------------

export function renderDaily({ date, day, orCheck, mtd, balance, railway, chatSize = "" }) {
  const lines = [];
  lines.push(`📊 Salem AI meter — ${fmtDay(date)} (Qatar day)`);
  let spend = `Spend: ${money(day.totalCost)}`;
  if (day.testCost > 0.0005) spend += ` (+ ${money(day.testCost)} commissioning tests)`;
  if (orCheck?.coverage === "full" && Number.isFinite(orCheck.spend)) {
    const metered = day.totalCost + (day.testCost || 0);
    const diff = orCheck.spend > 0 ? Math.abs(metered - orCheck.spend) / orCheck.spend : 0;
    spend += ` · OpenRouter says ${money(orCheck.spend)} (${(diff * 100).toFixed(1)}% apart)`;
  } else if (orCheck?.coverage === "partial" && Number.isFinite(orCheck.since)) {
    spend += ` · OpenRouter check starts with full days (sampling began ${new Date(orCheck.since).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
  }
  lines.push(spend);
  if (day.taskCount > 0) {
    lines.push(`Tasks: ${day.taskCount} · $/task median ${money(day.perTask.median)}, p90 ${money(day.perTask.p90)}, all-in avg ${money(day.perTask.allIn)}`);
  } else {
    lines.push("Tasks: 0 (no messages from you that day)");
  }
  const rooms = Object.entries(day.rooms).filter(([, c]) => c > 0.0005).sort((a, b) => b[1] - a[1]);
  if (rooms.length) lines.push("By room: " + rooms.map(([r, c]) => `${r} ${money(c)}`).join(" · "));
  if (day.byModel.length) lines.push("By model: " + day.byModel.slice(0, 6).map((m) => `${shortModel(m.model)} ${money(m.cost)}`).join(" · "));
  if (day.latency.replies) lines.push(`Speed (Jarvis model time per reply step): avg ${secs(day.latency.avgMs)}, slowest 5% ${secs(day.latency.p95Ms)}`);
  if (Number.isFinite(day.cacheHitRate)) lines.push(`Cache: ${(day.cacheHitRate * 100).toFixed(0)}% of input served from cache`);
  // R17: the size of Jarvis's chats with the owner now (every step re-sends the chat).
  if (chatSize) lines.push(chatSize);
  if (day.topTasks.length && day.taskCount > 1) lines.push("Top tasks: " + day.topTasks.map((t) => `${fmtClock(t.at)} ${money(t.cost)}`).join(" · "));
  if (day.background > 0.005) lines.push(`Background (no message, e.g. nightly memory): ${money(day.background)}`);
  const flags = [];
  if (day.maxToolCalls > 60) flags.push(`one chat made ${day.maxToolCalls} tool calls — check for a loop`);
  if (day.errors > 0) flags.push(`${day.errors} error${day.errors === 1 ? "" : "s"}`);
  if (day.missingCostEntries > 0) flags.push(`${day.missingCostEntries} calls without a price`);
  lines.push(flags.length ? `Watch: ${flags.join("; ")}` : "Loops/errors: none");
  if (mtd && Number.isFinite(mtd.cost)) {
    lines.push(`Month to date (OpenRouter): ${money(mtd.cost)} → about ${money(mtd.projection)} by month end`);
  }
  if (Number.isFinite(railway?.perDay)) {
    lines.push(`Railway (separate bill): ≈ ${money(railway.perDay)} that day, ≈ ${money(railway.perDay * 30)}/month at this rate — estimate from the container's own use (${railway.memGb.toFixed(1)} GB memory, ${Number.isFinite(railway.vcpu) ? railway.vcpu.toFixed(2) : "?"} vCPU, ${Number.isFinite(railway.diskGb) ? railway.diskGb.toFixed(0) : "?"} GB disk) at Railway's list prices; exact bill: Railway → Usage`);
  }
  if (Number.isFinite(balance?.balance)) {
    const runway = balance.commissioning
      ? " (no days estimate this week: its spend includes the commissioning tests)"
      : Number.isFinite(balance.runwayDays) ? ` (~${balance.runwayDays.toFixed(0)} days at this week's rate)` : "";
    lines.push(`OpenRouter balance: ${money(balance.balance)}${runway}`);
  }
  return lines.join("\n");
}

// Public benchmark reference (Claude's multi-source study, 26 Sep 2026; Artificial Analysis
// Intelligence Index v4.3.2 score and $/task on its eval set, OpenRouter prices). Static on purpose:
// it is refreshed by a person, never scraped into a live decision.
export const PUBLIC_REFERENCE = {
  indexVersion: "Artificial Analysis Intelligence Index v4.3.2 (study of 26 Sep 2026)",
  rows: [
    { model: "anthropic/claude-opus-5.5", setting: "max", score: 58, perTask: 5.98 },
    { model: "openai/gpt-6-sol", setting: "max", score: 48, perTask: 1.06 },
    { model: "meta/muse-spark-1.3", setting: "max", score: 48, perTask: 1.6 },
    { model: "xiaomi/mimo-v2.6-pro", setting: "default", score: 46, perTask: 0.13 },
    { model: "x-ai/grok-4.7", setting: "high", score: 46, perTask: 2.18 },
    { model: "meta/muse-spark-1.3", setting: "xhigh", score: 45, perTask: 1.37 },
    { model: "qwen/qwen3.8-max-0902", setting: "default", score: 45, perTask: 5.41 },
    { model: "openai/gpt-6-sol", setting: "high", score: 43, perTask: 0.37 },
  ],
};

const perMillion = (p) => (Number.isFinite(Number(p)) && String(p) !== "" ? Math.round(Number(p) * 1e9) / 1000 : NaN);

// Diff OpenRouter's public model list against last week's snapshot.
export function scoutModels({ current, previous, seatModels }) {
  const idx = (list) => new Map((list || []).map((m) => [m.id, m]));
  const cur = idx(current);
  const prev = idx(previous);
  const seatVendors = new Set(seatModels.map((m) => String(m).replace(/^openrouter\//, "").split("/")[0]));
  const priceChanges = [];
  for (const m of seatModels) {
    const id = String(m).replace(/^openrouter\//, "");
    const a = prev.get(id);
    const b = cur.get(id);
    if (!b) { priceChanges.push({ id, change: "no longer listed on OpenRouter" }); continue; }
    if (!a) continue;
    const pin = [perMillion(a.pricing?.prompt), perMillion(a.pricing?.completion)];
    const now = [perMillion(b.pricing?.prompt), perMillion(b.pricing?.completion)];
    if (pin[0] !== now[0] || pin[1] !== now[1]) {
      priceChanges.push({ id, change: `$${pin[0]}/$${pin[1]} → $${now[0]}/$${now[1]} per M tokens (in/out)` });
    }
  }
  const newFromSeatLabs = [];
  const newOtherLabs = [];
  if (previous && previous.length) {
    for (const [id, m] of cur) {
      if (prev.has(id)) continue;
      const vendor = id.split("/")[0];
      const entry = { id, price: `$${perMillion(m.pricing?.prompt)}/$${perMillion(m.pricing?.completion)}` };
      (seatVendors.has(vendor) ? newFromSeatLabs : newOtherLabs).push(entry);
    }
  }
  return { priceChanges, newFromSeatLabs, newOtherLabs, baseline: !previous || previous.length === 0 };
}

export function renderWeekly({ startDate, endDate, week, perSeat, scout, lineup }) {
  const lines = [];
  lines.push(`📈 Salem AI weekly $/task — ${fmtDay(startDate)} to ${fmtDay(endDate)}`);
  lines.push(`Tasks: ${week.taskCount} · spend ${money(week.totalCost)} · $/task median ${money(week.perTask.median)}, p90 ${money(week.perTask.p90)}, all-in avg ${money(week.perTask.allIn)}`);
  lines.push("");
  lines.push("Your seats this week (real use): seat — model: replies × $/reply = total");
  for (const s of perSeat) {
    const used = (s.models || []).filter((m) => m.calls > 0 || m.cost > 0);
    if (!used.length) { lines.push(`• ${s.label} (now ${shortModel(s.model)}) — no use this week`); continue; }
    const parts = used.slice(0, 3).map((m) => `${shortModel(m.model)}${shortModel(m.model) === shortModel(s.model) ? "" : " (earlier)"}: ${m.calls} × ${m.calls ? money(m.cost / m.calls) : "—"} = ${money(m.cost)}`);
    lines.push(`• ${s.label} — ${parts.join("; ")}`);
  }
  lines.push("");
  lines.push(`Public $/task reference (${PUBLIC_REFERENCE.indexVersion}):`);
  lines.push(PUBLIC_REFERENCE.rows.map((r) => `${shortModel(r.model)} ${r.setting} ${r.score}pts ${money(r.perTask)}`).join(" · "));
  lines.push("");
  if (scout.baseline) {
    lines.push("Prices/new models: baseline recorded this week; changes are reported from next week.");
  } else {
    lines.push(scout.priceChanges.length ? "Price changes: " + scout.priceChanges.map((p) => `${shortModel(p.id)} ${p.change}`).join("; ") : "Price changes on your seats: none");
    if (scout.newFromSeatLabs.length) lines.push("New from your seats' labs: " + scout.newFromSeatLabs.slice(0, 8).map((m) => `${m.id} ${m.price}`).join("; "));
    if (scout.newOtherLabs.length) lines.push("New from other labs (candidates for an open seat): " + scout.newOtherLabs.slice(0, 6).map((m) => `${m.id} ${m.price}`).join("; "));
  }
  if (lineup?.warnings?.length) lines.push("One-company rule: " + lineup.warnings.join("; "));
  lines.push("Nothing is switched automatically. To change a seat, ask Jarvis for the switch command, or send: /config set agents.entries.<seat-id>.model=<provider/model> (Jarvis itself: /model <provider/model> -a).");
  return lines.join("\n");
}

// ---- I/O shell -----------------------------------------------------------------------

export function createMeter({ stateDir, workspaceDir, dataDir = "/data", researchRunsDir = null, gatewayCall, sendWhatsApp, sendTelegram, fuseStatus, spendSamples, lineup, canQuery = () => true, chatSizeLine = async () => "", log = console, fetchImpl = fetch }) {
  const statePath = path.join(stateDir, "salem-meter-state.json");
  const modelsSnapshotPath = path.join(stateDir, "salem-openrouter-models.json");
  const reportsDir = path.join(workspaceDir, "reports");
  const containerPath = path.join(stateDir, "salem-container-usage.json");
  const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
  const writeJson = (p, v) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); } catch {} };
  let busy = false;

  // Railway bills what the container actually uses (memory, CPU, volume). The kernel's
  // cgroup counters are the same numbers, so sampling them gives an honest estimate
  // without a Railway API token. Samples every 5 minutes, kept 40 days.
  const readNum = (p) => { try { return Number(fs.readFileSync(p, "utf8").trim().split(/\s+/)[0]); } catch { return NaN; } };
  function readCpuSeconds() {
    try {
      const stat = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
      const m = stat.match(/usage_usec\s+(\d+)/);
      if (m) return Number(m[1]) / 1e6;
    } catch {}
    const ns = readNum("/sys/fs/cgroup/cpuacct/cpuacct.usage");
    return Number.isFinite(ns) ? ns / 1e9 : NaN;
  }
  function sampleContainer(now = Date.now()) {
    let mem = readNum("/sys/fs/cgroup/memory.current");
    if (!Number.isFinite(mem)) mem = readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    let disk = NaN;
    try { const st = fs.statfsSync(dataDir); disk = (st.blocks - st.bfree) * st.bsize; } catch {}
    const store = readJson(containerPath, { samples: [] });
    store.samples = (store.samples || []).filter((x) => now - x.t < 40 * DAY);
    store.samples.push({ t: now, memGb: mem / 1e9, cpuS: readCpuSeconds(), diskGb: disk / 1e9 });
    writeJson(containerPath, store);
  }
  function railwayEstimate(dateStr, rates = { memGbMonth: 10, vcpuMonth: 20, diskGbMonth: 0.15 }) {
    const start = qatarDayStartMs(dateStr);
    const list = (readJson(containerPath, { samples: [] }).samples || []).filter((x) => x.t >= start && x.t < start + DAY).sort((a, b) => a.t - b.t);
    if (list.length < 12) return { perDay: NaN, samples: list.length };
    const avg = (k) => { const v = list.map((x) => x[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
    let cpuS = 0; let wallS = 0;
    for (let i = 1; i < list.length; i += 1) {
      const d = list[i].cpuS - list[i - 1].cpuS;
      const w = (list[i].t - list[i - 1].t) / 1000;
      if (Number.isFinite(d) && d >= 0 && w > 0 && w < 3600) { cpuS += d; wallS += w; }
    }
    const vcpu = wallS > 0 ? cpuS / wallS : NaN;
    const memGb = avg("memGb");
    const diskGb = avg("diskGb");
    const perDay = (memGb * rates.memGbMonth + (Number.isFinite(vcpu) ? vcpu : 0) * rates.vcpuMonth + (Number.isFinite(diskGb) ? diskGb : 0) * rates.diskGbMonth) / 30;
    return { perDay, memGb, vcpu, diskGb, samples: list.length };
  }

  async function usageFor(startDate, endDate) {
    const params = { agentScope: "all", startDate, endDate, mode: "specific", timeZone: "Asia/Qatar", limit: 2000 };
    let last = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = await gatewayCall("sessions.usage", params);
      const status = last?.cacheStatus?.status;
      if (!status || status === "fresh") return last;
      await new Promise((r) => setTimeout(r, 4000));
    }
    return last;
  }

  const testLedgerPath = path.join(stateDir, "meter-test-sessions.json");
  const readTestLedger = () => { try { return JSON.parse(fs.readFileSync(testLedgerPath, "utf8")); } catch { return { ids: [], days: [] }; } };

  // R14: run records of the research runner that finished in [windowStart, windowEnd).
  function researchRuns(windowStart, windowEnd) {
    if (!researchRunsDir) return [];
    const runs = [];
    try {
      for (const f of fs.readdirSync(researchRunsDir)) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(researchRunsDir, f);
        try {
          if (fs.statSync(p).mtimeMs < windowStart) continue; // written when the run finished
          const s = JSON.parse(fs.readFileSync(p, "utf8"));
          const t = Date.parse(s?.finished_at);
          if (Number.isFinite(t) && t >= windowStart && t < windowEnd) runs.push(s);
        } catch {}
      }
    } catch {}
    return runs;
  }

  async function day(dateStr) {
    const windowStart = qatarDayStartMs(dateStr);
    let res = await usageFor(dateStr, dateStr);
    try {
      const extra = researchRunsRows(researchRuns(windowStart, windowStart + DAY), windowStart, windowStart + DAY);
      if (extra.length) res = { ...(res || {}), sessions: [...(res?.sessions ?? []), ...extra] };
    } catch (err) { log.warn?.("[meter] research runs not counted: " + String(err).slice(0, 120)); }
    const d = computeDay(res, { windowStart, windowEnd: windowStart + DAY, isTest: testMatcher(readTestLedger()) });
    d.cacheStatus = res?.cacheStatus?.status ?? null;
    return d;
  }

  async function monthToDate(dateStr) {
    const first = `${dateStr.slice(0, 8)}01`;
    const res = await gatewayCall("usage.cost", { startDate: first, endDate: dateStr, mode: "specific", timeZone: "Asia/Qatar" });
    const cost = Number(res?.totals?.totalCost);
    const daysElapsed = Number(dateStr.slice(8, 10));
    const y = Number(dateStr.slice(0, 4));
    const m = Number(dateStr.slice(5, 7));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { cost, projection: Number.isFinite(cost) && daysElapsed > 0 ? (cost / daysElapsed) * daysInMonth : NaN };
  }

  async function dailyReport(dateStr) {
    const d = await day(dateStr);
    const start = qatarDayStartMs(dateStr);
    const orCheck = openRouterSpend(spendSamples(), start, Math.min(start + DAY, Date.now()));
    const mtd = await monthToDate(dateStr);
    const f = fuseStatus();
    const railway = railwayEstimate(dateStr);
    let chatSize = "";
    try { chatSize = await chatSizeLine(); } catch (err) { log.warn?.("[meter] chat size unavailable: " + String(err).slice(0, 120)); }
    const text = renderDaily({ date: dateStr, day: d, orCheck, mtd, balance: { balance: f.balance, runwayDays: f.runwayDays, commissioning: Boolean(f.runwayCommissioning) }, railway, chatSize });
    return { text, day: d, orCheck, mtd, railway, chatSize };
  }

  async function refreshLatest() {
    const today = qatarDate();
    const yesterday = addDays(today, -1);
    const t = await dailyReport(today);
    const y = await dailyReport(yesterday);
    const md = [
      "# Salem AI meter (auto-generated by the wrapper; numbers only)",
      "",
      `Updated: ${new Date().toISOString()} (refreshed hourly). When the owner says "meter", reply with the two blocks below as they are.`,
      "",
      "## Today so far",
      "",
      t.text.replace(/\(Qatar day\)/, "(Qatar day, so far)"),
      "",
      "## Yesterday",
      "",
      y.text,
      "",
    ].join("\n");
    try {
      fs.mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(reportsDir, "meter-latest.md"), md, { mode: 0o644 });
      fs.writeFileSync(path.join(reportsDir, "meter-latest.json"), JSON.stringify({ at: new Date().toISOString(), today: { date: today, ...t }, yesterday: { date: yesterday, ...y } }, null, 2) + "\n", { mode: 0o644 });
    } catch (err) {
      log.warn(`[meter-v1] could not write meter-latest: ${String(err)}`);
    }
    return { today: t, yesterday: y };
  }

  async function weeklyReport(endDate) {
    const startDate = addDays(endDate, -6);
    let res = await usageFor(startDate, endDate);
    const windowStart = qatarDayStartMs(startDate);
    const windowEnd = qatarDayStartMs(endDate) + DAY;
    try {
      const extra = researchRunsRows(researchRuns(windowStart, windowEnd), windowStart, windowEnd);
      if (extra.length) res = { ...(res || {}), sessions: [...(res?.sessions ?? []), ...extra] };
    } catch (err) { log.warn?.("[meter] research runs not counted: " + String(err).slice(0, 120)); }
    const week = computeDay(res, { windowStart, windowEnd, isTest: testMatcher(readTestLedger()) });
    const lu = lineup() || {};
    const seats = [
      ...(lu.jarvis ? [lu.jarvis] : []),
      ...(lu.forum || []),
      ...(lu.counsel || []),
      ...(lu.research || []),
    ];
    const perSeat = seats.map((s) => ({
      id: s.id,
      label: SEAT_LABELS[s.id] || s.id,
      model: s.model,
      calls: week.byAgent[s.id]?.calls ?? 0,
      cost: week.byAgent[s.id]?.cost ?? 0,
      models: week.byAgentModel?.[s.id] ?? [],
    }));
    let current = [];
    try {
      const r = await fetchImpl("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(30_000) });
      if (r.ok) current = ((await r.json())?.data ?? []).map((m) => ({ id: m.id, pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion }, created: m.created }));
    } catch (err) {
      log.warn(`[meter-v1] OpenRouter model list unavailable: ${String(err)}`);
    }
    const snap = readJson(modelsSnapshotPath, null);
    const scout = scoutModels({ current, previous: snap?.models ?? null, seatModels: seats.map((s) => s.model).filter(Boolean) });
    const text = renderWeekly({ startDate, endDate, week, perSeat, scout, lineup: lu });
    return { text, week, perSeat, scout, current };
  }

  async function deliver(kind, text) {
    let wa = null;
    try { wa = await sendWhatsApp(text); } catch (err) { wa = { ok: false, error: String(err).slice(0, 160) }; }
    if (wa?.ok) return { ok: true, via: "whatsapp" };
    let tg = null;
    try { tg = await sendTelegram(text); } catch (err) { tg = { ok: false, error: String(err).slice(0, 160) }; }
    log.warn(`[meter-v1] ${kind} WhatsApp delivery failed (${wa?.error ?? "unknown"}); Telegram ${tg?.ok ? "ok" : "failed"}`);
    return { ok: Boolean(tg?.ok), via: tg?.ok ? "telegram" : "none", waError: wa?.error, tgError: tg?.error };
  }

  // Called every minute by the wrapper.
  async function tick(now = Date.now()) {
    if (busy) return;
    busy = true;
    try {
      const st = readJson(statePath, {});
      if (!st.lastContainerAt || now - st.lastContainerAt >= 5 * 60 * 1000 - 5000) {
        sampleContainer(now);
        st.lastContainerAt = now;
        writeJson(statePath, st);
      }
      if (!canQuery()) return; // gateway stopped: reports wait (and are sent late) instead of failing
      const today = qatarDate(now);
      const h = qatarHour(now);
      const m = qatarMinute(now);
      if (h >= 7 && st.lastDaily !== today) {
        const yesterday = addDays(today, -1);
        const r = await dailyReport(yesterday);
        const sent = await deliver("daily", r.text);
        st.lastDaily = today;
        st.lastDailyResult = { at: new Date(now).toISOString(), date: yesterday, ...sent, cost: r.day.totalCost, openRouter: r.orCheck?.spend ?? null, tasks: r.day.taskCount };
        writeJson(statePath, st);
        log.log("[meter-v1] daily " + JSON.stringify(st.lastDailyResult));
      }
      if (qatarWeekday(now) === 0 && (h > 7 || (h === 7 && m >= 5)) && st.lastWeekly !== today) {
        const endDate = addDays(today, -1);
        const r = await weeklyReport(endDate);
        const sent = await deliver("weekly", r.text);
        if (r.current.length) writeJson(modelsSnapshotPath, { at: new Date(now).toISOString(), models: r.current });
        st.lastWeekly = today;
        st.lastWeeklyResult = { at: new Date(now).toISOString(), endDate, ...sent, tasks: r.week.taskCount };
        writeJson(statePath, st);
        log.log("[meter-v1] weekly " + JSON.stringify(st.lastWeeklyResult));
      }
      if (!st.lastLatestAt || now - st.lastLatestAt > HOUR) {
        await refreshLatest();
        st.lastLatestAt = now;
        writeJson(statePath, st);
      }
    } catch (err) {
      log.warn(`[meter-v1] tick failed: ${String(err).slice(0, 200)}`);
    } finally {
      busy = false;
    }
  }

  return {
    tick, day, dailyReport, weeklyReport, refreshLatest, deliver, sampleContainer, railwayEstimate,
    state: () => readJson(statePath, {}),
    saveModelsSnapshot: (models) => writeJson(modelsSnapshotPath, { at: new Date().toISOString(), models }),
  };
}
