// R17 (Claude, 2026-09-26): keep the owner's chats with Jarvis small.
//
// Measured 26 Sep: Salem's WhatsApp chat with Jarvis had grown to ~281k tokens (288 messages
// since 22 Sep, mostly setup and diagnostic work) and every Jarvis step re-sent all of it:
// 5–8 s and ≈$1.35 per message. OpenClaw compacts only near the model's own window (1.05M
// tokens for GPT-6 Sol), so nothing trimmed it. This keeper uses OpenClaw's own model-backed
// compaction (gateway sessions.compact) on an owner chat once it is over the cap AND has been
// quiet for a while, so a summary never delays one of Salem's messages. OpenClaw refuses to
// compact a chat with an active run or queued work; the keeper then simply tries again later.
//
// Pure helpers are exported for the tests; createChatSizeKeeper wires them to the gateway.

export const CHAT_CAP_TOKENS = 60_000;
export const CHAT_QUIET_MS = 10 * 60_000;
export const CHAT_RETRY_MS = 30 * 60_000;

// Jarvis's chats with the owner: WhatsApp/Telegram DMs and Jarvis's main session.
const OWNER_CHAT_RE = /^agent:main:(?:(?:whatsapp|telegram):direct:[^:\s]+|main)$/;

export function isOwnerChatKey(key) {
  return OWNER_CHAT_RE.test(String(key ?? ""));
}

const toMs = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
};

// Owner chat rows from a sessions.list result (OpenClaw v2026.9.6 rows carry key, sessionId,
// totalTokens = the latest prompt size, updatedAt/lastInteractionAt/endedAt in ms, hasActiveRun),
// whatever its nesting. Rows without a token count are kept with totalTokens NaN.
export function ownerChatRows(listResult) {
  const rows = new Map();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 6) return;
    if (!Array.isArray(o) && typeof o.key === "string" && isOwnerChatKey(o.key) && o.archived !== true) {
      const prev = rows.get(o.key);
      const times = [o.updatedAt, o.lastInteractionAt, o.endedAt].map(toMs).filter(Number.isFinite);
      const row = {
        key: o.key,
        sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
        totalTokens: o.totalTokens !== null && Number.isFinite(Number(o.totalTokens)) ? Number(o.totalTokens) : NaN,
        lastActivityAt: times.length ? Math.max(...times) : NaN,
        active: o.hasActiveRun === true || o.status === "running",
      };
      const newer = Number.isFinite(row.lastActivityAt) && (!Number.isFinite(prev?.lastActivityAt) || row.lastActivityAt > prev.lastActivityAt);
      if (!prev || newer) rows.set(o.key, row);
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(listResult);
  return Array.from(rows.values());
}

// Which chats to summarise now: over the cap, no run in progress, quiet long enough, and not
// tried too recently.
export function chatsToCompact(rows, { now = Date.now(), capTokens = CHAT_CAP_TOKENS, quietMs = CHAT_QUIET_MS, retryMs = CHAT_RETRY_MS, lastAttempt = {} } = {}) {
  return (rows || []).filter((r) =>
    Number.isFinite(r.totalTokens) && r.totalTokens > capTokens
    && !r.active
    && Number.isFinite(r.lastActivityAt) && now - r.lastActivityAt >= quietMs
    && !(Number.isFinite(lastAttempt[r.key]) && now - lastAttempt[r.key] < retryMs));
}

const channelLabel = (key) => (/:whatsapp:/.test(key) ? "WhatsApp" : /:telegram:/.test(key) ? "Telegram" : "main");
const kTokens = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`);

// One line for the daily report, e.g. "Jarvis chat size now: WhatsApp 14k tokens · Telegram 3.2k
// tokens (summarised automatically above 60k)". Empty when nothing is known.
export function chatSizeLine(rows, capTokens = CHAT_CAP_TOKENS) {
  const known = (rows || []).filter((r) => Number.isFinite(r.totalTokens) && r.totalTokens > 0 && r.key !== "agent:main:main");
  if (!known.length) return "";
  const order = { WhatsApp: 0, Telegram: 1, main: 2 };
  const parts = known
    .map((r) => ({ label: channelLabel(r.key), tokens: r.totalTokens }))
    .sort((a, b) => order[a.label] - order[b.label])
    .map((p) => `${p.label} ${kTokens(p.tokens)} tokens${p.tokens > capTokens ? " (over the cap — summarising when quiet)" : ""}`);
  return `Jarvis chat size now: ${parts.join(" · ")} (summarised automatically above ${kTokens(capTokens)})`;
}

export function createChatSizeKeeper({ gatewayCall, canQuery = () => true, log = console, capTokens = CHAT_CAP_TOKENS, quietMs = CHAT_QUIET_MS, retryMs = CHAT_RETRY_MS }) {
  const lastAttempt = {};
  let busy = false;
  let lastRows = [];
  let lastResult = null;

  async function rows() {
    const res = await gatewayCall("sessions.list", { agentId: "main", limit: 500 }, 60_000);
    lastRows = ownerChatRows(res);
    return lastRows;
  }

  async function compact(key) {
    const t0 = Date.now();
    lastAttempt[key] = t0;
    try {
      const r = await gatewayCall("sessions.compact", { key }, 400_000);
      const out = { key, at: new Date(t0).toISOString(), ok: r?.ok !== false, compacted: Boolean(r?.compacted), reason: r?.reason ?? null, ms: Date.now() - t0 };
      log.log("[chat-size-v1] compact " + JSON.stringify(out));
      lastResult = out;
      return out;
    } catch (err) {
      const out = { key, at: new Date(t0).toISOString(), ok: false, error: String(err).slice(0, 200), ms: Date.now() - t0 };
      log.warn("[chat-size-v1] compact failed " + JSON.stringify(out));
      lastResult = out;
      return out;
    }
  }

  // Called every few minutes by the wrapper.
  async function tick(now = Date.now()) {
    if (busy || !canQuery()) return null;
    busy = true;
    try {
      const list = await rows();
      const due = chatsToCompact(list, { now, capTokens, quietMs, retryMs, lastAttempt });
      const results = [];
      for (const r of due) {
        if (!canQuery()) break;
        log.log(`[chat-size-v1] ${r.key.replace(/\+\d{4,}/, (m) => m.slice(0, 5) + "…")} at ${r.totalTokens} tokens (cap ${capTokens}) — summarising the older part`);
        results.push(await compact(r.key));
      }
      return { checked: list.length, compacted: results };
    } catch (err) {
      log.warn(`[chat-size-v1] tick failed: ${String(err).slice(0, 200)}`);
      return null;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    rows,
    compact,
    line: async () => {
      try { return chatSizeLine(await rows(), capTokens); } catch { return chatSizeLine(lastRows, capTokens); }
    },
    status: () => ({ capTokens, quietMs, retryMs, lastRows, lastAttempt: { ...lastAttempt }, lastResult }),
  };
}
