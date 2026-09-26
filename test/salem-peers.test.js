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

test("gateway processes are found by their command line; other openclaw commands are not", () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "salem-proc-"));
  const mk = (pid, args) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), "cmdline"), args.join("\0") + "\0"); };
  mk(101, ["node", "/openclaw/dist/entry.js", "gateway", "run", "--bind", "loopback", "--port", "18789", "--auth", "token", "--token", "x"]);
  mk(102, ["node", "/openclaw/dist/entry.js", "gateway", "call", "health", "--json"]);
  mk(103, ["node", "/openclaw/dist/entry.js", "gateway", "run", "--port", "19999"]);
  mk(104, ["bash", "-c", "sleep 1"]);
  fs.mkdirSync(path.join(proc, "self"));
  assert.deepEqual(findGatewayPids({ port: 18789, procDir: proc }).sort(), [101]);
  assert.deepEqual(findGatewayPids({ port: 18789, procDir: proc, excludePids: [101] }), []);
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
