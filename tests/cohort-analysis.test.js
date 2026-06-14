import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/cohort-analysis-test-" + Date.now();

test.before(() => {
  process.env.STORAGE_PATH = TEST_DIR;
  mkdirSync(join(TEST_DIR, "cohorts"), { recursive: true });
});

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
function dayKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function offsetDay(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

/**
 * Seed signups/activity directly to disk with controlled timestamps so we can
 * exercise retention/churn/dau/mau calculations against historical data.
 */
async function seed(signups, events) {
  writeFileSync(
    join(TEST_DIR, "cohorts", "signups.json"),
    JSON.stringify({ _version: 1, signups }),
    "utf8",
  );
  writeFileSync(
    join(TEST_DIR, "cohorts", "activity.json"),
    JSON.stringify({ _version: 1, events }),
    "utf8",
  );
}

await test("recordUserSignup persists a signup with cohort keys", async () => {
  const { recordUserSignup, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const rec = await recordUserSignup("user-1", "ws-a", { source: "test" });
  assert.equal(rec.userId, "user-1");
  assert.equal(rec.workspaceId, "ws-a");
  assert.match(rec.cohortDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(rec.cohortWeek, /^\d{4}-W\d{2}$/);
  assert.match(rec.cohortMonth, /^\d{4}-\d{2}$/);
  assert.deepEqual(rec.metadata, { source: "test" });
});

await test("recordUserSignup is idempotent per (user, workspace)", async () => {
  const { recordUserSignup, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const a = await recordUserSignup("user-1", "ws-a");
  const b = await recordUserSignup("user-1", "ws-a");
  assert.equal(a.signupAt, b.signupAt);
});

await test("recordUserActivity stores events for authenticated users only", async () => {
  const { recordUserActivity, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const skipped = await recordUserActivity("anonymous", "ws-a", "request");
  assert.equal(skipped, null);
  const stored = await recordUserActivity("user-1", "ws-a", "request");
  assert.ok(stored);
  assert.equal(stored.userId, "user-1");
  assert.equal(stored.eventType, "request");
});

await test("getCohortRetention computes retention matrix from seeded data", async () => {
  // Build a single weekly cohort: 4 users signing up "today minus 14 days"
  // (period 0). We simulate activity in periods 0, 1, 2 (days 0-6, 7-13, 14-20).
  const signupDate = offsetDay(14);
  const signupDay = dayKey(signupDate);
  const baseSignup = {
    workspaceId: "ws-a",
    signupAt: signupDate.toISOString(),
    cohortDay: signupDay,
    // Force same cohortWeek/cohortMonth so they group together
    cohortWeek: "2099-W01",
    cohortMonth: "2099-01",
    metadata: {},
  };
  const signups = [
    { ...baseSignup, userId: "u1" },
    { ...baseSignup, userId: "u2" },
    { ...baseSignup, userId: "u3" },
    { ...baseSignup, userId: "u4" },
  ];

  const events = [];
  // Period 0 (days 0-6 from signup): all 4 active on signup day
  for (const u of ["u1", "u2", "u3", "u4"]) {
    events.push({ userId: u, workspaceId: "ws-a", eventType: "request", day: dayKey(offsetDay(14)), ts: offsetDay(14).toISOString() });
  }
  // Period 1 (days 7-13): u1, u2, u3 active 10 days after signup => offsetDay(4)
  for (const u of ["u1", "u2", "u3"]) {
    events.push({ userId: u, workspaceId: "ws-a", eventType: "request", day: dayKey(offsetDay(4)), ts: offsetDay(4).toISOString() });
  }
  // Period 2 (days 14-20): u1, u2 active. Signup day was 14d ago, so day-14 from
  // signup = today = offsetDay(0).
  for (const u of ["u1", "u2"]) {
    events.push({ userId: u, workspaceId: "ws-a", eventType: "request", day: dayKey(offsetDay(0)), ts: offsetDay(0).toISOString() });
  }
  await seed(signups, events);

  const { getCohortRetention } = await import("../lib/cohort-analysis.js");
  const result = await getCohortRetention({ cohortGranularity: "week", periods: 4 });
  assert.equal(result.granularity, "week");
  assert.equal(result.periods, 4);
  const cohort = result.cohorts.find((c) => c.date === "2099-W01");
  assert.ok(cohort, "expected cohort 2099-W01");
  assert.equal(cohort.size, 4);
  // 4/4, 3/4, 2/4, 0/4
  assert.equal(cohort.retention[0], 1);
  assert.equal(cohort.retention[1], 0.75);
  assert.equal(cohort.retention[2], 0.5);
  assert.equal(cohort.retention[3], 0);
});

await test("getCohortRetention handles day granularity", async () => {
  const { getCohortRetention, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const today = new Date();
  const signups = [
    {
      userId: "u1",
      workspaceId: "ws",
      signupAt: today.toISOString(),
      cohortDay: dayKey(today),
      cohortWeek: "2099-W02",
      cohortMonth: "2099-02",
      metadata: {},
    },
  ];
  const events = [
    { userId: "u1", workspaceId: "ws", eventType: "request", day: dayKey(today), ts: today.toISOString() },
  ];
  await seed(signups, events);
  const result = await getCohortRetention({ cohortGranularity: "day", periods: 3 });
  const cohort = result.cohorts.find((c) => c.date === dayKey(today));
  assert.ok(cohort);
  assert.equal(cohort.size, 1);
  assert.equal(cohort.retention[0], 1);
});

await test("getDailyActiveUsers returns a series of unique-user counts", async () => {
  const { getDailyActiveUsers, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const today = dayKey(offsetDay(0));
  const yesterday = dayKey(offsetDay(1));
  await seed(
    [],
    [
      { userId: "u1", workspaceId: "ws", eventType: "request", day: today, ts: offsetDay(0).toISOString() },
      { userId: "u2", workspaceId: "ws", eventType: "request", day: today, ts: offsetDay(0).toISOString() },
      { userId: "u1", workspaceId: "ws", eventType: "request", day: today, ts: offsetDay(0).toISOString() }, // duplicate
      { userId: "u3", workspaceId: "ws", eventType: "request", day: yesterday, ts: offsetDay(1).toISOString() },
    ],
  );
  const result = await getDailyActiveUsers(7);
  assert.equal(result.days, 7);
  assert.equal(result.series.length, 7);
  const todayBucket = result.series.find((s) => s.day === today);
  const yesterdayBucket = result.series.find((s) => s.day === yesterday);
  assert.equal(todayBucket.users, 2);
  assert.equal(yesterdayBucket.users, 1);
  assert.ok(result.average > 0);
});

await test("getMonthlyActiveUsers aggregates unique users per month", async () => {
  const { getMonthlyActiveUsers, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const today = offsetDay(0);
  const monthKey = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}`;
  await seed(
    [],
    [
      { userId: "u1", workspaceId: "ws", eventType: "request", day: dayKey(today), ts: today.toISOString() },
      { userId: "u2", workspaceId: "ws", eventType: "request", day: dayKey(today), ts: today.toISOString() },
      { userId: "u1", workspaceId: "ws", eventType: "request", day: dayKey(today), ts: today.toISOString() },
    ],
  );
  const result = await getMonthlyActiveUsers(3);
  const bucket = result.series.find((s) => s.month === monthKey);
  assert.ok(bucket);
  assert.equal(bucket.users, 2);
});

await test("getChurnRate computes prior vs current window", async () => {
  const { getChurnRate, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  // 30d window. Prior window = days 30-59 ago. u1, u2, u3 active in prior; u1
  // also active in current. Expected: churned = u2, u3 (2/3).
  const prior = offsetDay(45);
  const current = offsetDay(5);
  await seed(
    [],
    [
      { userId: "u1", workspaceId: "ws", eventType: "request", day: dayKey(prior), ts: prior.toISOString() },
      { userId: "u2", workspaceId: "ws", eventType: "request", day: dayKey(prior), ts: prior.toISOString() },
      { userId: "u3", workspaceId: "ws", eventType: "request", day: dayKey(prior), ts: prior.toISOString() },
      { userId: "u1", workspaceId: "ws", eventType: "request", day: dayKey(current), ts: current.toISOString() },
    ],
  );
  const result = await getChurnRate("30d");
  assert.equal(result.days, 30);
  assert.equal(result.activeUsers, 1);
  assert.equal(result.churnedUsers, 2);
  assert.ok(Math.abs(result.churnRate - 0.6667) < 0.001);
});

await test("getChurnRate returns 0 when no prior activity", async () => {
  const { getChurnRate, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  await seed([], []);
  const result = await getChurnRate("30d");
  assert.equal(result.churnRate, 0);
  assert.equal(result.churnedUsers, 0);
  assert.equal(result.activeUsers, 0);
});

await test("getCohortFeatureAdoption returns adoption percent for a cohort", async () => {
  const { getCohortFeatureAdoption } = await import("../lib/cohort-analysis.js");
  const today = new Date();
  const cohortKey = "2099-W03";
  const signups = [
    { userId: "u1", workspaceId: "ws", signupAt: today.toISOString(), cohortDay: dayKey(today), cohortWeek: cohortKey, cohortMonth: "2099-03", metadata: {} },
    { userId: "u2", workspaceId: "ws", signupAt: today.toISOString(), cohortDay: dayKey(today), cohortWeek: cohortKey, cohortMonth: "2099-03", metadata: {} },
    { userId: "u3", workspaceId: "ws", signupAt: today.toISOString(), cohortDay: dayKey(today), cohortWeek: cohortKey, cohortMonth: "2099-03", metadata: {} },
    { userId: "u4", workspaceId: "ws", signupAt: today.toISOString(), cohortDay: dayKey(today), cohortWeek: cohortKey, cohortMonth: "2099-03", metadata: {} },
  ];
  const events = [
    { userId: "u1", workspaceId: "ws", eventType: "agent_mode", day: dayKey(today), ts: today.toISOString() },
    { userId: "u2", workspaceId: "ws", eventType: "agent_mode", day: dayKey(today), ts: today.toISOString() },
    { userId: "u3", workspaceId: "ws", eventType: "request", day: dayKey(today), ts: today.toISOString() },
  ];
  await seed(signups, events);
  const result = await getCohortFeatureAdoption("agent_mode", cohortKey);
  assert.equal(result.feature, "agent_mode");
  assert.equal(result.cohortDate, cohortKey);
  assert.equal(result.cohortSize, 4);
  assert.equal(result.adopted, 2);
  assert.equal(result.percent, 50);
});

await test("getCohortFeatureAdoption returns 0 for unknown cohort", async () => {
  const { getCohortFeatureAdoption, _resetCohortStore } = await import("../lib/cohort-analysis.js");
  await _resetCohortStore();
  const result = await getCohortFeatureAdoption("agent_mode", "1999-W01");
  assert.equal(result.cohortSize, 0);
  assert.equal(result.adopted, 0);
  assert.equal(result.percent, 0);
});
