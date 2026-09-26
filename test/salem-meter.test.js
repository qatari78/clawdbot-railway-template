import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDay, openRouterSpend, renderDaily, scoutModels, isOwnerTaskSession, qatarDate,
  qatarDayStartMs, addDays, percentile, renderWeekly, testMatcher,
} from "../src/salem-meter.js";

const Q = 15 * 60 * 1000;
// Qatar day 2026-09-25 = 2026-09-24T21:00Z .. 2026-09-25T21:00Z
const DAY = "2026-09-25";
const start = qatarDayStartMs(DAY);
const bucket = (isoUtc) => {
  const ms = Date.parse(isoUtc);
  const date = new Date(ms).toISOString().slice(0, 10);
  const qi = Math.floor((ms - Date.parse(`${date}T00:00:00Z`)) / Q);
  return { date, quarterIndex: qi };
};

function session(key, agentId, { costs = [], users = [], assistant = 0, toolCalls = 0, errors = 0, latency = null, models = [] } = {}) {
  return {
    key, agentId,
    usage: {
      modelUsage: models.map(([model, count, cost]) => ({ provider: "openrouter", model, count, totals: { totalCost: cost } })),
      utcQuarterHourTokenUsage: costs.map(([iso, c]) => ({ ...bucket(iso), totalCost: c })),
      utcQuarterHourMessageCounts: users.map(([iso, n]) => ({ ...bucket(iso), user: n })),
      messageCounts: { assistant, toolCalls, errors, user: users.reduce((s, [, n]) => s + n, 0) },
      latency,
    },
  };
}

test("qatar date helpers", () => {
  assert.equal(qatarDate(Date.parse("2026-09-25T20:59:00Z")), "2026-09-25");
  assert.equal(qatarDate(Date.parse("2026-09-25T21:00:00Z")), "2026-09-26");
  assert.equal(start, Date.parse("2026-09-24T21:00:00Z"));
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
});

test("owner task sessions", () => {
  assert.ok(isOwnerTaskSession("agent:main:whatsapp:direct:+97466586586"));
  assert.ok(isOwnerTaskSession("agent:main:telegram:direct:8992093410"));
  assert.ok(isOwnerTaskSession("agent:main:whatsapp:group:120363414703820287@g.us"));
  assert.ok(!isOwnerTaskSession("agent:main:main"));
  assert.ok(!isOwnerTaskSession("agent:main:explicit:claude-test-m1b-sol"));
  assert.ok(!isOwnerTaskSession("agent:forum-01:whatsapp:direct:+1"));
  assert.ok(!isOwnerTaskSession("agent:counsel-01:subagent:abc"));
});

test("costs are charged to the owner's most recent message; rooms and background split", () => {
  const result = {
    totals: { input: 100, cacheRead: 900, cacheWrite: 0, missingCostEntries: 0 },
    aggregates: { byModel: [{ model: "openai/gpt-6-sol", provider: "openrouter", count: 3, totals: { totalCost: 0.5 } }] },
    sessions: [
      // 00:05 Qatar = 21:05Z the day before: nightly background with no message yet
      session("agent:main:main", "main", { costs: [["2026-09-24T21:05:00Z", 0.2]] }),
      session("agent:main:whatsapp:direct:+974", "main", {
        users: [["2026-09-25T06:00:00Z", 1], ["2026-09-25T09:00:00Z", 2]],
        costs: [["2026-09-25T06:01:00Z", 0.01], ["2026-09-25T09:02:00Z", 0.04]],
        assistant: 3, latency: { count: 3, avgMs: 2000, p95Ms: 3000 },
      }),
      // Forum run triggered by the 06:00Z message, finishing 20 min later
      session("agent:forum-01:abc", "forum-01", { costs: [["2026-09-25T06:20:00Z", 1.0]], assistant: 1, models: [["x-ai/grok-4.7", 1, 1.0], ["gateway-injected", 2, 0]] }),
      session("agent:counsel-01:def", "counsel-01", { costs: [["2026-09-25T09:10:00Z", 3.0]], assistant: 1 }),
      // outside the window: must be ignored
      session("agent:main:whatsapp:direct:+974b", "main", { users: [["2026-09-25T22:00:00Z", 5]], costs: [["2026-09-25T22:00:00Z", 9]] }),
      // test session: reported separately, never a task
      session("agent:main:explicit:claude-test-x", "main", { users: [["2026-09-25T10:00:00Z", 1]], costs: [["2026-09-25T10:00:00Z", 0.3]], models: [["x-ai/grok-4.7", 5, 0.3]] }),
    ],
  };
  const d = computeDay(result, { windowStart: start, windowEnd: start + 86_400_000 });
  assert.equal(d.taskCount, 3);
  assert.ok(Math.abs(d.totalCost - 4.25) < 1e-9);
  assert.ok(Math.abs(d.testCost - 0.3) < 1e-9);
  assert.ok(Math.abs(d.background - 0.2) < 1e-9);
  // task at 06:00Z: 0.01 + 1.0; two tasks at 09:00Z share 0.04 + 3.0
  const costs = d.topTasks.map((t) => Math.round(t.cost * 1000) / 1000).sort();
  assert.deepEqual(costs, [1.01, 1.52, 1.52].sort());
  assert.ok(Math.abs(d.perTask.allIn - (4.05 / 3)) < 1e-9);
  assert.equal(d.rooms.Forum, 1.0);
  assert.equal(d.rooms.Counsel, 3.0);
  assert.ok(Math.abs(d.rooms.Jarvis - 0.25) < 1e-9);
  assert.equal(d.byAgent["counsel-01"].calls, 1);
  assert.equal(d.latency.avgMs, 2000);
  assert.equal(d.cacheHitRate, 0.9);
  // models come from real (non-test) rows; zero-cost pseudo models are hidden
  assert.deepEqual(d.byModel.map((m) => [m.model, m.calls, m.cost]), [["x-ai/grok-4.7", 1, 1.0]]);
  assert.deepEqual(d.byAgentModel["forum-01"].map((m) => m.model), ["x-ai/grok-4.7"]);
});

test("percentile", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test("openRouterSpend uses the cumulative key samples", () => {
  const s = [{ t: 0, usage: 10 }, { t: 100, usage: 12 }, { t: 200, usage: 15 }];
  assert.deepEqual(openRouterSpend(s, 100, 200), { spend: 3, coverage: "full" });
  assert.equal(openRouterSpend(s, 50, 200).spend, 5);
  assert.equal(openRouterSpend(s, -50, 200).coverage, "partial");
  assert.equal(openRouterSpend([{ t: 0, usage: 1 }], 0, 1).coverage, "none");
});

test("daily report text is short and complete", () => {
  const d = computeDay({ sessions: [], totals: {}, aggregates: {} }, { windowStart: start, windowEnd: start + 1 });
  const text = renderDaily({ date: DAY, day: d, orCheck: { spend: NaN }, mtd: { cost: 10, projection: 30 }, balance: { balance: 60, runwayDays: 9.4 }, railway: { perDay: 0.9, memGb: 2.1, vcpu: 0.3, diskGb: 29 } });
  assert.match(text, /Fri 25 Sep/);
  assert.match(text, /Tasks: 0/);
  assert.match(text, /Month to date \(OpenRouter\): \$10\.0/);
  assert.match(text, /Railway \(separate bill\)/);
  assert.match(text, /Railway \(separate bill\)/);
  assert.ok(text.length < 1500);
});

test("scout finds price changes and new models; first run is a baseline", () => {
  const prev = [{ id: "x-ai/grok-4.7", pricing: { prompt: "0.0000016", completion: "0.0000048" } }];
  const cur = [
    { id: "x-ai/grok-4.7", pricing: { prompt: "0.000002", completion: "0.0000048" } },
    { id: "x-ai/grok-5", pricing: { prompt: "0.000003", completion: "0.00001" } },
    { id: "google/gemini-4-pro", pricing: { prompt: "0.000002", completion: "0.00001" } },
  ];
  const s = scoutModels({ current: cur, previous: prev, seatModels: ["openrouter/x-ai/grok-4.7"] });
  assert.equal(s.priceChanges.length, 1);
  assert.match(s.priceChanges[0].change, /1\.6/);
  assert.deepEqual(s.newFromSeatLabs.map((m) => m.id), ["x-ai/grok-5"]);
  assert.deepEqual(s.newOtherLabs.map((m) => m.id), ["google/gemini-4-pro"]);
  assert.equal(scoutModels({ current: cur, previous: null, seatModels: [] }).baseline, true);
  const text = renderWeekly({ startDate: "2026-09-20", endDate: "2026-09-26", week: computeDay({ sessions: [] }, { windowStart: 0, windowEnd: 1 }), perSeat: [{ label: "Jarvis", model: "openrouter/openai/gpt-6-sol", calls: 0, cost: 0, models: [{ model: "x-ai/grok-4.7", calls: 4, cost: 2 }, { model: "openai/gpt-6-sol", calls: 10, cost: 0.03 }] }], scout: s, lineup: { warnings: [] } });
  assert.match(text, /Nothing is switched automatically/);
  assert.match(text, /grok-4\.7 \(earlier\): 4 × \$0\.50 = \$2\.00/);
  assert.match(text, /gpt-6-sol: 10 × \$0\.0030 = \$0\.03/);
});

test("deleted test sessions and commissioning days stay out of $/task", () => {
  const row = (key, date = "2026-09-26", quarterIndex = 40, cost = 1) => ({ key, usage: { utcQuarterHourTokenUsage: [{ date, quarterIndex, totalCost: cost }], modelUsage: [{ model: "openai/gpt-6-sol", count: 1, totals: { totalCost: cost } }] } });
  const m = testMatcher({ ids: ["aaaa-1111"], days: ["2026-09-26"] });
  assert.equal(m("agent:main:explicit:claude-test-x", row("agent:main:explicit:claude-test-x")), true);
  assert.equal(m("agent:main:aaaa-1111", row("agent:main:aaaa-1111", "2026-09-20")), true); // ledger id, any day
  assert.equal(m("agent:main:bbbb-2222", row("agent:main:bbbb-2222")), true);                // commissioning day
  assert.equal(m("agent:main:bbbb-2222", row("agent:main:bbbb-2222", "2026-09-28")), false); // ordinary day
  assert.equal(m("agent:main:whatsapp:direct:+97400000000", row("agent:main:whatsapp:direct:+97400000000")), false);
  assert.equal(m("agent:main:main", row("agent:main:main")), false);
  const noLedger = testMatcher(null);
  assert.equal(noLedger("agent:main:bbbb-2222", row("agent:main:bbbb-2222")), false);
});
