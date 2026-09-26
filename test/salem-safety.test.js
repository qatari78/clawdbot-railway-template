import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spendInWindow, createSafety } from "../src/salem-safety.js";

test("spend in a trailing window", () => {
  const s = [{ t: 0, usage: 10 }, { t: 60, usage: 12 }, { t: 120, usage: 30 }];
  assert.equal(spendInWindow(s, 120, 3600), 20);
  assert.equal(spendInWindow(s, 120, 60), 18);
  assert.equal(spendInWindow(s, 120, 0), 0);
});

test("after the owner restarts Jarvis, the fuse counts spend from the restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-safety-"));
  const cfgPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ channels: { telegram: { botToken: "1:x", allowFrom: ["123"] } } }));
  let usage = 10;
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("api.telegram.org")) { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({}) }; }
    if (String(url).endsWith("/key")) return { ok: true, json: async () => ({ data: { usage, usage_daily: 0, usage_weekly: 70 } }) };
    return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: usage } }) };
  };
  const safety = createSafety({ stateDir: dir, configPath: cfgPath, log: { log() {}, warn() {} }, fetchImpl, keyResolver: async () => ({ key: "k" }) });
  await safety.fuseTick({ stopGateway: async () => {} });   // sample at usage 10
  usage = 35;                                                 // +$25 within the hour → trips
  const f1 = await safety.fuseTick({ stopGateway: async () => {} });
  assert.equal(f1.tripped, true);
  assert.ok(safety.isLatched());
  safety.clearLatch("owner");                                 // owner restarts Jarvis
  const f2 = await safety.fuseTick({ stopGateway: async () => {} });
  assert.ok(f2.spend60 < 1, `fresh window after restart, got ${f2.spend60}`);
  assert.equal(safety.isLatched(), false);
  assert.ok(sent.some((t) => t.includes("MONEY FUSE")));
});

test("the fuse alerts once per stop, not every check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-safety-"));
  const cfgPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ channels: { telegram: { botToken: "1:x", allowFrom: ["123"] } } }));
  let usage = 10;
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("api.telegram.org")) { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({}) }; }
    if (String(url).endsWith("/key")) return { ok: true, json: async () => ({ data: { usage, usage_daily: 0, usage_weekly: 70 } }) };
    return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: usage } }) };
  };
  const safety = createSafety({ stateDir: dir, configPath: cfgPath, log: { log() {}, warn() {} }, fetchImpl, keyResolver: async () => ({ key: "k" }) });
  await safety.fuseTick({ stopGateway: async () => {} });
  usage = 40;
  await safety.fuseTick({ stopGateway: async () => {} });
  await safety.fuseTick({ stopGateway: async () => {} });
  await safety.fuseTick({ stopGateway: async () => {} });
  assert.equal(sent.filter((t) => t.includes("MONEY FUSE")).length, 1);
});

test("R13: a commissioning day in the current UTC week pauses the runway estimate's alert", async () => {
  const { commissioningWeek } = await import("../src/salem-safety.js");
  const sat = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(commissioningWeek(["2026-09-26"], sat), true);
  assert.equal(commissioningWeek(["2026-09-21"], sat), true);   // Monday of the same week
  assert.equal(commissioningWeek(["2026-09-20"], sat), false);  // previous week
  assert.equal(commissioningWeek(["2026-09-26"], Date.parse("2026-09-28T01:00:00Z")), false); // next week
  assert.equal(commissioningWeek(undefined, sat), false);

  for (const marked of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-safety-"));
    const cfgPath = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ channels: { telegram: { botToken: "1:x", allowFrom: ["123"] } } }));
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    if (marked) fs.writeFileSync(path.join(dir, "meter-test-sessions.json"), JSON.stringify({ ids: [], days: [today] }));
    const sent = [];
    const fetchImpl = async (url, init) => {
      if (String(url).includes("api.telegram.org")) { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({}) }; }
      if (String(url).endsWith("/key")) return { ok: true, json: async () => ({ data: { usage: 90, usage_daily: 40, usage_weekly: 88 } }) };
      return { ok: true, json: async () => ({ data: { total_credits: 108.5, total_usage: 90 } }) }; // balance $18.5, ~1.5 days
    };
    const safety = createSafety({ stateDir: dir, configPath: cfgPath, log: { log() {}, warn() {} }, fetchImpl, keyResolver: async () => ({ key: "k" }) });
    const f = await safety.fuseTick({ stopGateway: async () => {} });
    assert.equal(f.runwayCommissioning, marked);
    assert.equal(sent.some((t) => t.includes("covers about")), !marked, `marked=${marked}: ${JSON.stringify(sent)}`);
  }
});
