import fs from "node:fs";
import path from "node:path";
import { resolveOpenRouterKeyForRuntime } from "./openrouter-key-audit.js";

// Salem AI safety net (Claude, 2026-09-26): stop latch (B5), owner alerts (B4),
// money fuse (B3) and the gateway watchdog's restart budget (B2).
// Everything here runs in the wrapper process, independent of the OpenClaw gateway,
// so alerts still go out and stops still hold when the gateway is down or looping.

const HOUR = 60 * 60 * 1000;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJson(p, value) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return true;
  } catch { return false; }
}
const num = (v, d) => {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : d;
};

// Spend over the last `windowMs`, from cumulative-usage samples [{t, usage}] (oldest first).
export function spendInWindow(samples, now, windowMs) {
  const list = (samples || []).filter((s) => Number.isFinite(s?.usage) && Number.isFinite(s?.t));
  if (list.length === 0) return 0;
  const latest = list[list.length - 1];
  const cutoff = now - windowMs;
  let base = list[0];
  for (const s of list) {
    if (s.t <= cutoff) base = s; else break;
  }
  return Math.max(0, latest.usage - base.usage);
}

// R13: is a commissioning day (Qatar date, marked in the meter's test ledger) inside the current
// UTC week (Monday–Sunday) — the window of OpenRouter's usage_weekly, which the runway estimate
// uses? Then that estimate reflects test spend, not normal use.
export function commissioningWeek(testDays, now) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const start = new Date(monday).toISOString().slice(0, 10);
  const end = new Date(monday + 6 * 24 * HOUR).toISOString().slice(0, 10);
  return (Array.isArray(testDays) ? testDays : []).some((day) => typeof day === "string" && day >= start && day <= end);
}

export function createSafety({ stateDir, configPath, log = console, fetchImpl = fetch, keyResolver = null }) {
  const latchPath = path.join(stateDir, "jarvis-stop-latch.json");
  const alertLogPath = path.join(stateDir, "jarvis-alerts.jsonl");
  const spendPath = path.join(stateDir, "jarvis-spend-history.json");
  const watchdogPath = path.join(stateDir, "jarvis-watchdog.json");
  const fuseResetPath = path.join(stateDir, "jarvis-fuse-reset.json");
  // R8: alert de-duplication is kept on the volume, so two overlapping copies of the wrapper
  // (deploy overlap, leftover failed release) do not send the owner the same alert twice.
  const alertLastPath = path.join(stateDir, "jarvis-alert-last.json");
  const lastSent = new Map();
  const fuse = {
    lastCheck: null, spend60: null, usageTotal: null, usageDaily: null, usageWeekly: null,
    balance: null, runwayDays: null, runwayCommissioning: false, tripped: false, lastError: null,
  };
  const testLedgerPath = path.join(stateDir, "meter-test-sessions.json");
  let cachedKey = null;
  let cachedKeyAt = 0;

  // ---- B5 stop latch -------------------------------------------------------------
  const latchInfo = () => readJson(latchPath, null);
  const isLatched = () => Boolean(latchInfo());
  function setLatch(reason, by) {
    const info = { reason, by, at: new Date().toISOString() };
    writeJson(latchPath, info);
    log.log("[latch-v1] SET " + JSON.stringify(info));
    return info;
  }
  function clearLatch(by) {
    const prev = latchInfo();
    try { fs.unlinkSync(latchPath); } catch {}
    // After the owner restarts Jarvis, the money fuse counts spend from the restart onwards;
    // otherwise the spike that tripped it (still inside the trailing hour) would trip it again.
    if (prev) writeJson(fuseResetPath, { at: Date.now(), by, prevReason: prev.reason });
    fuse.tripped = false;
    log.log("[latch-v1] CLEARED " + JSON.stringify({ by, prev }));
    return prev;
  }

  // ---- B4 owner alerts (Telegram direct; independent of the gateway) -------------
  function alertTarget() {
    const cfg = readJson(configPath, {});
    const tg = cfg.channels?.telegram ?? {};
    const token = tg.botToken || tg.accounts?.default?.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    const ids = [
      ...(Array.isArray(tg.allowFrom) ? tg.allowFrom : []),
      ...((cfg.commands?.ownerAllowFrom || [])
        .filter((e) => typeof e === "string" && e.startsWith("telegram:"))
        .map((e) => e.slice("telegram:".length))),
    ].map(String).filter((id) => /^-?\d+$/.test(id));
    return { token, chatId: ids[0] || null };
  }

  async function sendAlert(kind, text, { force = false, dedupeMs = 30 * 60 * 1000 } = {}) {
    const now = Date.now();
    const shared = readJson(alertLastPath, {});
    const prev = Math.max(lastSent.get(kind) || 0, Number(shared?.[kind]) || 0);
    if (!force && now - prev < dedupeMs) return { ok: true, deduped: true };
    lastSent.set(kind, now);
    writeJson(alertLastPath, { ...(shared && typeof shared === "object" ? shared : {}), [kind]: now });
    const { token, chatId } = alertTarget();
    const record = { at: new Date(now).toISOString(), kind, text: String(text).slice(0, 500) };
    let ok = false;
    let error = null;
    if (!token || !chatId) {
      error = "no-telegram-target";
    } else {
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `⚠️ Salem AI — ${text}`, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
        ok = res.ok;
        if (!ok) error = `telegram-http-${res.status}`;
      } catch (err) {
        error = String(err).slice(0, 120);
      }
    }
    try { fs.appendFileSync(alertLogPath, JSON.stringify({ ...record, ok, error }) + "\n", { mode: 0o600 }); } catch {}
    log.log("[alert-v1] " + JSON.stringify({ kind, ok, error }));
    return { ok, error };
  }

  // Plain owner message on Telegram (daily/weekly reports when WhatsApp is unavailable).
  async function sendTelegramText(text) {
    const { token, chatId } = alertTarget();
    if (!token || !chatId) return { ok: false, error: "no-telegram-target" };
    const parts = [];
    for (let s = String(text); s.length > 0; s = s.slice(3900)) parts.push(s.slice(0, 3900));
    try {
      for (const part of parts) {
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { ok: false, error: `telegram-http-${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 120) };
    }
  }

  // ---- B3 money fuse ---------------------------------------------------------------
  const thresholds = () => ({
    alertPerHour: num(process.env.JARVIS_FUSE_ALERT_USD_PER_HOUR, 5),
    stopPerHour: num(process.env.JARVIS_FUSE_STOP_USD_PER_HOUR, 20),
    lowBalance: num(process.env.JARVIS_FUSE_LOW_BALANCE_USD, 10),
    runwayDays: num(process.env.JARVIS_FUSE_RUNWAY_DAYS, 3),
    dryRun: process.env.JARVIS_FUSE_DRYRUN?.trim() === "1",
  });

  async function openRouterKey() {
    if (cachedKey && Date.now() - cachedKeyAt < HOUR) return cachedKey;
    const r = keyResolver ? await keyResolver() : await resolveOpenRouterKeyForRuntime({ stateDir, configPath });
    cachedKey = r.key;
    cachedKeyAt = Date.now();
    return cachedKey;
  }

  // Authenticated OpenRouter request with the working key (privacy routing checks).
  async function openRouterRequest(pathname, { method = "GET", body } = {}) {
    const key = await openRouterKey();
    if (!key) throw new Error("no working OpenRouter key found");
    const res = await fetchImpl(`https://openrouter.ai/api/v1${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "X-OpenRouter-Title": "Salem AI commissioning" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, json };
  }

  async function orGet(pathname, key) {
    const res = await fetchImpl(`https://openrouter.ai/api/v1${pathname}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`openrouter ${pathname} http ${res.status}`);
    const body = await res.json();
    return body?.data ?? body;
  }

  async function fuseTick({ stopGateway, thresholdsOverride = null, label = "" } = {}) {
    const t = thresholdsOverride ? { ...thresholds(), ...thresholdsOverride } : thresholds();
    const tag = label ? `(${label}) ` : "";
    const now = Date.now();
    try {
      const key = await openRouterKey();
      if (!key) throw new Error("no working OpenRouter key found");
      const keyInfo = await orGet("/key", key);
      let credits = null;
      try { credits = await orGet("/credits", key); } catch (err) { fuse.lastError = String(err).slice(0, 120); }
      const usage = num(keyInfo?.usage, NaN);
      const history = readJson(spendPath, { samples: [] });
      history.samples = (history.samples || []).filter((s) => now - s.t < 9 * 24 * HOUR);
      if (Number.isFinite(usage)) history.samples.push({ t: now, usage });
      writeJson(spendPath, history);

      fuse.lastCheck = new Date(now).toISOString();
      fuse.usageTotal = Number.isFinite(usage) ? usage : null;
      fuse.usageDaily = num(keyInfo?.usage_daily, null);
      fuse.usageWeekly = num(keyInfo?.usage_weekly, null);
      const resetAt = Number(readJson(fuseResetPath, null)?.at) || 0;
      fuse.spend60 = spendInWindow(history.samples, now, Math.min(HOUR, Math.max(0, now - resetAt)));
      fuse.windowStart = new Date(now - Math.min(HOUR, Math.max(0, now - resetAt))).toISOString();
      if (credits && Number.isFinite(num(credits.total_credits, NaN))) {
        fuse.balance = num(credits.total_credits, 0) - num(credits.total_usage, 0);
      }
      const dailyAvg = fuse.usageWeekly != null ? fuse.usageWeekly / 7 : null;
      fuse.runwayDays = fuse.balance != null && dailyAvg && dailyAvg > 0 ? fuse.balance / dailyAvg : null;
      // R13: in a week with commissioning tests the runway estimate is driven by test spend, so the
      // low-runway alert waits for the next week; the low-balance alert (< $10) stays on.
      fuse.runwayCommissioning = commissioningWeek(readJson(testLedgerPath, null)?.days, now);

      const alreadyStopped = !t.dryRun && latchInfo()?.reason === "money-fuse";
      if (fuse.spend60 > t.stopPerHour && alreadyStopped) {
        // Already stopped by the fuse: stay quiet (one alert per stop, not one every 5 minutes).
        fuse.tripped = true;
      } else if (fuse.spend60 > t.stopPerHour) {
        const msg = `${tag}MONEY FUSE: $${fuse.spend60.toFixed(2)} spent in the last hour (limit $${t.stopPerHour}). ` +
          (t.dryRun ? "Dry run — Jarvis NOT stopped." : "Jarvis has been STOPPED and will stay stopped until restarted from /setup.");
        if (!t.dryRun) {
          fuse.tripped = true;
          setLatch("money-fuse", `spend60=$${fuse.spend60.toFixed(2)}`);
          try { await stopGateway?.(); } catch {}
        }
        await sendAlert("money-fuse-stop", msg, { force: true });
      } else if (fuse.spend60 > t.alertPerHour) {
        await sendAlert("money-fuse-alert", `${tag}High spend: $${fuse.spend60.toFixed(2)} in the last hour (alert level $${t.alertPerHour}; stop level $${t.stopPerHour}).`, { force: Boolean(label) });
      }
      if (fuse.balance != null && fuse.balance < t.lowBalance) {
        await sendAlert("low-balance", `OpenRouter balance is low: $${fuse.balance.toFixed(2)} left. Top up to keep Jarvis running.`, { dedupeMs: 12 * HOUR });
      } else if (fuse.runwayDays != null && fuse.runwayDays < t.runwayDays && !fuse.runwayCommissioning) {
        await sendAlert("low-runway", `OpenRouter balance $${fuse.balance.toFixed(2)} covers about ${fuse.runwayDays.toFixed(1)} days at this week's spend rate.`, { dedupeMs: 12 * HOUR });
      }
      log.log("[fuse-v1] " + JSON.stringify({ ...fuse, thresholds: t }));
    } catch (err) {
      fuse.lastError = String(err).slice(0, 160);
      log.warn("[fuse-v1] check failed: " + fuse.lastError);
    }
    return { ...fuse };
  }

  // ---- B2 watchdog restart budget ------------------------------------------------
  function restartBudget(now = Date.now()) {
    const state = readJson(watchdogPath, { restarts: [] });
    const recent = (state.restarts || []).filter((t) => now - t < HOUR);
    return { recent, remaining: Math.max(0, 3 - recent.length) };
  }
  function recordRestart(now = Date.now()) {
    const { recent } = restartBudget(now);
    recent.push(now);
    writeJson(watchdogPath, { restarts: recent });
    return recent.length;
  }
  function resetRestarts() {
    writeJson(watchdogPath, { restarts: [] });
  }
  // Last alerts sent to the owner (for checks after tests): time, kind, delivered, text.
  function recentAlerts(n = 8) {
    try {
      const lines = fs.readFileSync(alertLogPath, "utf8").trim().split("\n").slice(-n);
      return lines.map((l) => { try { const r = JSON.parse(l); return { at: r.at, kind: r.kind, ok: r.ok, text: String(r.text || "").slice(0, 120) }; } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  return {
    latchInfo, isLatched, setLatch, clearLatch,
    sendAlert, sendTelegramText, alertTarget: () => { const a = alertTarget(); return { hasToken: Boolean(a.token), chatId: a.chatId ? "set" : null }; },
    fuseTick, fuseStatus: () => ({ ...fuse, thresholds: thresholds() }),
    spendSamples: () => readJson(spendPath, { samples: [] }).samples || [],
    openRouterRequest,
    restartBudget, recordRestart, resetRestarts, recentAlerts,
  };
}
