/**
 * Phase 36.5: Security scorecard tests.
 * Covers individual checks, score calculation, category aggregation,
 * grade assignment, and history tracking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set STORAGE_PATH to a fresh temp dir BEFORE importing the module so that
// the scorecard file path is correctly resolved.
const TMP_DIR = await fs.mkdtemp(join(tmpdir(), "siskelbot-scorecard-"));
process.env.STORAGE_PATH = TMP_DIR;

const {
  SCORECARD_CHECKS,
  runSecurityScan,
  runAndSaveSecurityScan,
  getLatestScorecard,
  getScorecardHistory,
  getCheckDetail,
  getGrade,
  stopDailySecurityScan,
  _resetScorecardHistoryForTests,
} = await import("../lib/security-scorecard.js");

/**
 * Save, mutate, restore env vars cleanly for each test.
 */
function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  })();
}

test("getGrade returns A/B/C/D/F boundaries", () => {
  assert.equal(getGrade(100), "A");
  assert.equal(getGrade(90), "A");
  assert.equal(getGrade(89), "B");
  assert.equal(getGrade(80), "B");
  assert.equal(getGrade(79), "C");
  assert.equal(getGrade(70), "C");
  assert.equal(getGrade(69), "D");
  assert.equal(getGrade(60), "D");
  assert.equal(getGrade(59), "F");
  assert.equal(getGrade(0), "F");
});

test("SCORECARD_CHECKS has at least 15 well-formed checks", () => {
  const entries = Object.entries(SCORECARD_CHECKS);
  assert.ok(entries.length >= 15, `expected >=15 checks, got ${entries.length}`);
  for (const [id, def] of entries) {
    assert.equal(typeof def.category, "string", `${id} missing category`);
    assert.equal(typeof def.weight, "number", `${id} missing weight`);
    assert.ok(def.weight > 0, `${id} weight must be positive`);
    assert.equal(typeof def.check, "function", `${id} missing check()`);
  }
});

test("api_key_set check passes when API_KEY is present and fails otherwise", () => {
  return withEnv({ API_KEY: "secret" }, async () => {
    assert.equal(await SCORECARD_CHECKS.api_key_set.check(), "pass");
  }).then(() =>
    withEnv({ API_KEY: undefined }, async () => {
      assert.equal(await SCORECARD_CHECKS.api_key_set.check(), "fail");
    }),
  );
});

test("no_default_secrets flags weak values", () => {
  return withEnv({ API_KEY: "changeme" }, async () => {
    assert.equal(await SCORECARD_CHECKS.no_default_secrets.check(), "fail");
  }).then(() =>
    withEnv({ API_KEY: "super-long-random-value-abc123" }, async () => {
      assert.equal(await SCORECARD_CHECKS.no_default_secrets.check(), "pass");
    }),
  );
});

test("cors_restricted fails on wildcard, passes on explicit", () => {
  return withEnv({ CORS_ORIGIN: "*" }, async () => {
    assert.equal(await SCORECARD_CHECKS.cors_restricted.check(), "fail");
  })
    .then(() =>
      withEnv({ CORS_ORIGIN: "https://example.com" }, async () => {
        assert.equal(await SCORECARD_CHECKS.cors_restricted.check(), "pass");
      }),
    )
    .then(() =>
      withEnv({ CORS_ORIGIN: undefined }, async () => {
        assert.equal(await SCORECARD_CHECKS.cors_restricted.check(), "warn");
      }),
    );
});

test("runSecurityScan with override produces a scorecard with score+grade", async () => {
  const fakeChecks = {
    always_pass: { category: "test", weight: 10, check: () => "pass", remediation: "n/a" },
    always_warn: { category: "test", weight: 10, check: () => "warn", remediation: "fix it" },
    always_fail: { category: "other", weight: 10, check: () => "fail", remediation: "fix it" },
  };
  const sc = await runSecurityScan({ checks: fakeChecks });
  // pass=10 + warn=5 + fail=0 = 15/30 => 50
  assert.equal(sc.score, 50);
  assert.equal(sc.grade, "F");
  assert.equal(sc.totalChecks, 3);
  assert.equal(sc.counts.pass, 1);
  assert.equal(sc.counts.warn, 1);
  assert.equal(sc.counts.fail, 1);
  assert.ok(sc.timestamp);
  assert.ok(sc.byCategory.test);
  assert.ok(sc.byCategory.other);
});

test("runSecurityScan aggregates scores per category correctly", async () => {
  const fakeChecks = {
    a: { category: "auth", weight: 10, check: () => "pass" },
    b: { category: "auth", weight: 10, check: () => "pass" },
    c: { category: "storage", weight: 10, check: () => "fail", remediation: "x" },
    d: { category: "storage", weight: 10, check: () => "warn", remediation: "y" },
  };
  const sc = await runSecurityScan({ checks: fakeChecks });
  assert.equal(sc.byCategory.auth.score, 100);
  assert.equal(sc.byCategory.auth.grade, "A");
  assert.equal(sc.byCategory.auth.pass, 2);
  assert.equal(sc.byCategory.auth.fail, 0);
  // storage: fail=0 + warn=5 => 5/20 = 25
  assert.equal(sc.byCategory.storage.score, 25);
  assert.equal(sc.byCategory.storage.grade, "F");
  assert.equal(sc.byCategory.storage.fail, 1);
  assert.equal(sc.byCategory.storage.warn, 1);
});

test("runSecurityScan recommendations include non-pass checks sorted by weight", async () => {
  const fakeChecks = {
    small_warn: { category: "x", weight: 2, check: () => "warn", remediation: "small" },
    big_fail: { category: "x", weight: 10, check: () => "fail", remediation: "big" },
    middle_warn: { category: "x", weight: 5, check: () => "warn", remediation: "mid" },
    ok: { category: "x", weight: 10, check: () => "pass", remediation: "n/a" },
  };
  const sc = await runSecurityScan({ checks: fakeChecks });
  assert.equal(sc.recommendations.length, 3); // excludes "ok"
  assert.equal(sc.recommendations[0].id, "big_fail");
  assert.equal(sc.recommendations[1].id, "middle_warn");
  assert.equal(sc.recommendations[2].id, "small_warn");
});

test("runSecurityScan catches thrown errors in checks and marks them fail", async () => {
  const fakeChecks = {
    boom: {
      category: "x",
      weight: 10,
      check: () => { throw new Error("kaboom"); },
      remediation: "handle",
    },
    ok: { category: "x", weight: 10, check: () => "pass" },
  };
  const sc = await runSecurityScan({ checks: fakeChecks });
  const boom = sc.checks.find((c) => c.id === "boom");
  assert.equal(boom.status, "fail");
  assert.equal(boom.error, "kaboom");
  // Only ok contributes: 10/20 = 50
  assert.equal(sc.score, 50);
});

test("runSecurityScan with real SCORECARD_CHECKS produces valid structure", async () => {
  const sc = await runSecurityScan();
  assert.ok(sc.score >= 0 && sc.score <= 100);
  assert.ok(["A", "B", "C", "D", "F"].includes(sc.grade));
  assert.equal(sc.totalChecks, Object.keys(SCORECARD_CHECKS).length);
  assert.equal(
    sc.counts.pass + sc.counts.warn + sc.counts.fail,
    sc.totalChecks,
  );
});

test("runAndSaveSecurityScan persists history, getLatestScorecard returns newest", async () => {
  await _resetScorecardHistoryForTests();
  const first = await runAndSaveSecurityScan();
  // Tiny delay so timestamps differ
  await new Promise((r) => setTimeout(r, 10));
  const second = await runAndSaveSecurityScan();
  const latest = await getLatestScorecard();
  assert.equal(latest.timestamp, second.timestamp);
  assert.notEqual(first.timestamp, second.timestamp);
});

test("getScorecardHistory respects the days window", async () => {
  await _resetScorecardHistoryForTests();
  const scorecardFile = join(TMP_DIR, "security-scorecard.json");
  const now = Date.now();
  const history = [
    { timestamp: new Date(now - 1 * 24 * 3600 * 1000).toISOString(), score: 90, grade: "A", counts: { pass: 5, warn: 0, fail: 0 } },
    { timestamp: new Date(now - 5 * 24 * 3600 * 1000).toISOString(), score: 80, grade: "B", counts: { pass: 4, warn: 1, fail: 0 } },
    { timestamp: new Date(now - 40 * 24 * 3600 * 1000).toISOString(), score: 60, grade: "D", counts: { pass: 2, warn: 2, fail: 1 } },
  ];
  await fs.writeFile(scorecardFile, JSON.stringify({ history }), "utf8");

  const last30 = await getScorecardHistory(30);
  assert.equal(last30.length, 2);
  const last7 = await getScorecardHistory(7);
  assert.equal(last7.length, 2);
  const last2 = await getScorecardHistory(2);
  assert.equal(last2.length, 1);
  const last60 = await getScorecardHistory(60);
  assert.equal(last60.length, 3);
});

test("getLatestScorecard returns null when no history", async () => {
  await _resetScorecardHistoryForTests();
  const latest = await getLatestScorecard();
  assert.equal(latest, null);
});

test("getCheckDetail returns an individual check from the latest scorecard", async () => {
  await _resetScorecardHistoryForTests();
  await runAndSaveSecurityScan();
  const detail = await getCheckDetail("api_key_set");
  assert.ok(detail);
  assert.equal(detail.id, "api_key_set");
  assert.equal(detail.category, "authentication");
  const missing = await getCheckDetail("nonexistent_check");
  assert.equal(missing, null);
});

test("scorecard achieves grade A when all checks pass", async () => {
  const allPass = {
    c1: { category: "a", weight: 10, check: () => "pass" },
    c2: { category: "a", weight: 10, check: () => "pass" },
    c3: { category: "b", weight: 10, check: () => "pass" },
  };
  const sc = await runSecurityScan({ checks: allPass });
  assert.equal(sc.score, 100);
  assert.equal(sc.grade, "A");
});

test("scorecard achieves grade F when all checks fail", async () => {
  const allFail = {
    c1: { category: "a", weight: 10, check: () => "fail", remediation: "r" },
    c2: { category: "a", weight: 10, check: () => "fail", remediation: "r" },
  };
  const sc = await runSecurityScan({ checks: allFail });
  assert.equal(sc.score, 0);
  assert.equal(sc.grade, "F");
});

test("cleanup: stop daily scan and remove tmp dir", async () => {
  stopDailySecurityScan();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});
