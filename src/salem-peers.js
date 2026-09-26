import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Salem AI peer awareness (Claude, 2026-09-26) — R8.
//
// Railway can run two containers of this service on the same /data volume for a while: during
// every deploy (old and new overlap briefly) and when a failed release leaves its container
// running for minutes. On 26 Sep the failed R7 container kept running for 7 minutes next to R7b;
// its watchdog saw "no gateway" and sent the owner a false "needs attention" alert.
//
// Each wrapper writes a small heartbeat file. A wrapper whose own gateway is not running, and
// which sees another live copy that is running Jarvis or that started later, stands by: it
// starts no gateway and runs no watchdog, fuse, meter or alert work until that copy is gone.

export const PEER_FRESH_MS = 60_000;
const DAY = 24 * 60 * 60 * 1000;

// Pure decision: should `self` stand by, given the other wrappers' heartbeats?
export function standbyDecision(self, peers, { gatewayRunning, nowMs, freshMs = PEER_FRESH_MS }) {
  if (gatewayRunning) return { standby: false, reason: "this copy runs Jarvis" };
  const live = (peers || []).filter((p) => p && p.id && p.id !== self.id && !p.stopping
    && nowMs - Number(p.at || 0) <= freshMs);
  const running = live.find((p) => p.gatewayRunning);
  if (running) return { standby: true, reason: "another copy is running Jarvis", peer: running };
  const newer = live.find((p) => Number(p.startedAt || 0) > self.startedAt);
  if (newer) return { standby: true, reason: "a newer copy has started", peer: newer };
  return { standby: false, reason: live.length ? "the other copy is older and not running Jarvis" : "no other copy" };
}

export function createPeers({ stateDir, log = console, now = () => Date.now(), env = process.env, freshMs = PEER_FRESH_MS }) {
  const dir = path.join(stateDir, "wrapper-peers");
  const self = {
    id: crypto.randomUUID(),
    pid: process.pid,
    startedAt: now(),
    deploymentId: env.RAILWAY_DEPLOYMENT_ID || null,
    replicaId: env.RAILWAY_REPLICA_ID || null,
    commit: String(env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || null,
  };
  const file = path.join(dir, `${self.id}.json`);
  let stopping = false;
  let gatewayRunningNow = false;
  let lastLogged = null;

  function beat(gatewayRunning = gatewayRunningNow) {
    gatewayRunningNow = Boolean(gatewayRunning);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...self, at: now(), gatewayRunning: gatewayRunningNow, stopping }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn?.(`[peers-v1] heartbeat write failed: ${String(err).slice(0, 120)}`);
    }
  }

  function readPeers() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    const t = now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const p = path.join(dir, name);
      try {
        const info = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!info || info.id === self.id) continue;
        if (t - Number(info.at || 0) > DAY) { try { fs.unlinkSync(p); } catch {} continue; }
        out.push(info);
      } catch {}
    }
    return out;
  }

  // Decision for this copy right now; logs only when it changes.
  function status(gatewayRunning = gatewayRunningNow) {
    const d = standbyDecision(self, readPeers(), { gatewayRunning, nowMs: now(), freshMs });
    const key = d.standby ? `standby:${d.peer?.id}` : "active";
    if (key !== lastLogged) {
      lastLogged = key;
      const peer = d.peer
        ? ` (peer ${String(d.peer.id).slice(0, 8)}, deploy ${String(d.peer.deploymentId || "?").slice(0, 8)}, started ${new Date(Number(d.peer.startedAt || 0)).toISOString()})`
        : "";
      log.log(`[peers-v1] ${d.standby ? "STANDBY" : "active"}: ${d.reason}${peer}`);
    }
    return d;
  }

  function markStopping() {
    stopping = true;
    beat();
  }

  function info() {
    const t = now();
    const peers = readPeers();
    return {
      self: { ...self, stopping, gatewayRunning: gatewayRunningNow },
      peers: peers.map((p) => ({ ...p, ageSec: Math.round((t - Number(p.at || 0)) / 1000) })),
      decision: standbyDecision(self, peers, { gatewayRunning: gatewayRunningNow, nowMs: t, freshMs }),
    };
  }

  return { self, beat, status, markStopping, info };
}
