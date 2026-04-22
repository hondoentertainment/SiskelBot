import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "eval-live-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  liveSamplingEnabled,
  shouldSample,
  getSampleRate,
  recordLiveEvalResult,
  getLiveQualitySummary,
  sampleAndJudge,
} = await import("../lib/eval-live-sampling.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("liveSamplingEnabled: off by default", () => {
  const prev = process.env.EVAL_LIVE_SAMPLING;
  delete process.env.EVAL_LIVE_SAMPLING;
  try {
    assert.equal(liveSamplingEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.EVAL_LIVE_SAMPLING = prev;
  }
});

test("liveSamplingEnabled: on when flag set", () => {
  const prev = process.env.EVAL_LIVE_SAMPLING;
  process.env.EVAL_LIVE_SAMPLING = "1";
  try {
    assert.equal(liveSamplingEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.EVAL_LIVE_SAMPLING;
    else process.env.EVAL_LIVE_SAMPLING = prev;
  }
});

test("getSampleRate: returns default when unset", () => {
  const prev = process.env.EVAL_LIVE_SAMPLE_RATE;
  delete process.env.EVAL_LIVE_SAMPLE_RATE;
  try {
    assert.equal(getSampleRate(), 0.02);
  } finally {
    if (prev !== undefined) process.env.EVAL_LIVE_SAMPLE_RATE = prev;
  }
});

test("getSampleRate: clamps to [0,1]", () => {
  const prev = process.env.EVAL_LIVE_SAMPLE_RATE;
  try {
    process.env.EVAL_LIVE_SAMPLE_RATE = "-0.5";
    assert.equal(getSampleRate(), 0);
    process.env.EVAL_LIVE_SAMPLE_RATE = "2";
    assert.equal(getSampleRate(), 1);
    process.env.EVAL_LIVE_SAMPLE_RATE = "0.3";
    assert.equal(getSampleRate(), 0.3);
  } finally {
    if (prev === undefined) delete process.env.EVAL_LIVE_SAMPLE_RATE;
    else process.env.EVAL_LIVE_SAMPLE_RATE = prev;
  }
});

test("shouldSample: false when flag off", () => {
  const prev = process.env.EVAL_LIVE_SAMPLING;
  delete process.env.EVAL_LIVE_SAMPLING;
  try {
    assert.equal(shouldSample(1, () => 0), false);
  } finally {
    if (prev !== undefined) process.env.EVAL_LIVE_SAMPLING = prev;
  }
});

test("shouldSample: respects rng and rate", () => {
  const prev = process.env.EVAL_LIVE_SAMPLING;
  process.env.EVAL_LIVE_SAMPLING = "1";
  try {
    assert.equal(shouldSample(0, () => 0), false);
    assert.equal(shouldSample(1, () => 0.99), true);
    assert.equal(shouldSample(0.5, () => 0.4), true);
    assert.equal(shouldSample(0.5, () => 0.6), false);
  } finally {
    if (prev === undefined) delete process.env.EVAL_LIVE_SAMPLING;
    else process.env.EVAL_LIVE_SAMPLING = prev;
  }
});

test("recordLiveEvalResult + getLiveQualitySummary: persists and summarizes", async () => {
  const ok1 = await recordLiveEvalResult({
    runId: "r1", workspace: "ws-live", userMessage: "hi", pass: true, reason: "good", model: "m",
  });
  const ok2 = await recordLiveEvalResult({
    runId: "r2", workspace: "ws-live", userMessage: "hi2", pass: false, reason: "bad", model: "m",
  });
  assert.equal(ok1, true);
  assert.equal(ok2, true);
  const sum = await getLiveQualitySummary({ workspace: "ws-live" });
  assert.equal(sum.total, 2);
  assert.equal(sum.passed, 1);
  assert.equal(sum.passRate, 0.5);
  assert.equal(sum.recent.length, 2);
});

test("sampleAndJudge: returns not-sampled when flag off", async () => {
  const prev = process.env.EVAL_LIVE_SAMPLING;
  delete process.env.EVAL_LIVE_SAMPLING;
  try {
    const r = await sampleAndJudge({ assistantOutput: "x" });
    assert.equal(r.sampled, false);
    assert.equal(r.judged, false);
  } finally {
    if (prev !== undefined) process.env.EVAL_LIVE_SAMPLING = prev;
  }
});
