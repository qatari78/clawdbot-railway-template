import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { standbyDecision, createPeers } from "../src/salem-peers.js";
import { findGatewayPids } from "../src/salem-procs.js";
import { createSafety } from "../src/salem-safety.js";

const quiet = { log() {}, warn() {} };

test("standby rules: a copy running Jarvis never stands by; others defer to it or to a newer copy", () => {
  const self = { id: "a", startedAt: 1_000 };
  const now = 100_000;
  const peer = (o) => ({ id: "b", startedAt: 2_000, at: now - 5_000, gatewayRunning: false, stopping: false, ...o });
  assert.equal(standbyDecision(self, [peer({ gatewayRunning: true })], { gatewayRunning: true, nowMs: now }).standby, false);
  assert.equal(standbyDecision(self, [peer({ gatewayRunning: true, startedAt: 500 })], { gatewayRunning: false, nowMs: now }).standby, true);
  assert.equal(standbyDecision(self, [peer({})], { gatewayRunning: false, nowMs: now }).standby, true); // newer copy
  assert.equal(standbyDecision(self, [peer({ startedAt: 500 })], { gatewayRunning: false, nowMs: now }).standby, false); // older idle copy
  assert.equal(standbyDecision(self, [peer({ gatewayRunning: true, at: now - 120_000 })], { gatewayRunning: false, nowMs: now }).standby, false); // stale heartbeat
  assert.equal(standbyDecision(self, [peer({ gatewayRunning: true, stopping: true })], { gatewayRunning: false, nowMs: now }).standby, false); // leaving
  assert.equal(standbyDecision(self, [], { gatewayRunning: false, nowMs: now }).standby, false);
});

test("two wrappers on one volume: deploy overlap and a leftover failed release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-peers-"));
  let t = 1_000_000;
  const now = () => t;
  const old = createPeers({ stateDir: dir, log: quiet, now, env: { RAILWAY_DEPLOYMENT_ID: "old" } });
  t += 60_000;
  const fresh = createPeers({ stateDir: dir, log: quiet, now, env: { RAILWAY_DEPLOYMENT_ID: "new" } });
  // Deploy overlap: the old copy runs Jarvis, the new copy waits.
  old.beat(true);
  fresh.beat(false);
  assert.equal(old.status(true).standby, false);
  assert.equal(fresh.status(false).standby, true);
  // The old copy is told to stop: the new copy takes over at once.
  old.markStopping();
  assert.equal(fresh.status(false).standby, false);
  // Leftover failed release: an older idle copy defers to the newer copy running Jarvis.
  const ghost = createPeers({ stateDir: dir, log: quiet, now: () => t - 30_000, env: {} });
  fresh.beat(true);
  assert.equal(ghost.status(false).standby, true);
  // A copy killed without notice (no "stopping" mark) stops blocking others after a minute.
  t += 90_000;
  ghost.beat(false);
  const late = createPeers({ stateDir: dir, log: quiet, now, env: {} });
  assert.equal(late.status(false).standby, false);
  assert.equal(late.info().peers.length, 3);
});

test("gateway processes are found as owners of the listening gateway port, not by command line", () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "salem-proc-"));
  fs.mkdirSync(path.join(proc, "net"));
  // 127.0.0.1:18789 LISTEN (inode 5551); 127.0.0.1:18789 ESTABLISHED client (inode 5552); :8080 LISTEN (inode 5553)
  fs.writeFileSync(path.join(proc, "net", "tcp"), [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:4965 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5551 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:4965 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 5552 1 0000000000000000 20 4 30 10 -1",
    "   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5553 1 0000000000000000 100 0 0 10 0",
  ].join("\n") + "\n");
  const mk = (pid, sockets) => {
    fs.mkdirSync(path.join(proc, String(pid), "fd"), { recursive: true });
    sockets.forEach((inode, i) => fs.symlinkSync(`socket:[${inode}]`, path.join(proc, String(pid), "fd", String(10 + i))));
  };
  mk(101, [5551]);        // the gateway (every OpenClaw process is titled "openclaw", so the port decides)
  mk(102, [5552]);        // an "openclaw gateway call" client connected to it
  mk(103, [5553]);        // the wrapper's own listener
  fs.mkdirSync(path.join(proc, "self"));
  assert.deepEqual(findGatewayPids({ port: 18789, procDir: proc }), [101]);
  assert.deepEqual(findGatewayPids({ port: 18789, procDir: proc, excludePids: [101] }), []);
  assert.deepEqual(findGatewayPids({ port: 19999, procDir: proc }), []);
});

test("alert de-duplication is shared by copies of the wrapper on the same volume", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-alerts-"));
  const cfgPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ channels: { telegram: { botToken: "1:x", allowFrom: ["123"] } } }));
  const sent = [];
  const fetchImpl = async (_url, init) => { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({}) }; };
  const a = createSafety({ stateDir: dir, configPath: cfgPath, log: quiet, fetchImpl });
  const b = createSafety({ stateDir: dir, configPath: cfgPath, log: quiet, fetchImpl });
  await a.sendAlert("watchdog-escalation", "needs attention", { dedupeMs: 60_000 });
  const r = await b.sendAlert("watchdog-escalation", "needs attention", { dedupeMs: 60_000 });
  assert.equal(r.deduped, true);
  assert.equal(sent.length, 1);
  a.recordRestart(); a.recordRestart();
  assert.equal(b.restartBudget().remaining, 1);
  b.resetRestarts();
  assert.equal(a.restartBudget().remaining, 3);
});
