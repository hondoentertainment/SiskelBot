import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveStagingTracesDirectory,
  listStagingTraceSummaries,
} from "../lib/eval-staging-traces.js";

test("resolveStagingTracesDirectory defaults to data/eval-sets/traces", () => {
  const prevS = process.env.STORAGE_PATH;
  const prevE = process.env.EVAL_STAGING_TRACES_DIR;
  delete process.env.STORAGE_PATH;
  delete process.env.EVAL_STAGING_TRACES_DIR;
  try {
    const d = resolveStagingTracesDirectory();
    assert.ok(d.replace(/\\/g, "/").endsWith("data/eval-sets/traces"));
  } finally {
    if (prevS !== undefined) process.env.STORAGE_PATH = prevS;
    else delete process.env.STORAGE_PATH;
    if (prevE !== undefined) process.env.EVAL_STAGING_TRACES_DIR = prevE;
    else delete process.env.EVAL_STAGING_TRACES_DIR;
  }
});

test("resolveStagingTracesDirectory respects STORAGE_PATH", () => {
  const prevS = process.env.STORAGE_PATH;
  const prevE = process.env.EVAL_STAGING_TRACES_DIR;
  delete process.env.EVAL_STAGING_TRACES_DIR;
  process.env.STORAGE_PATH = join(tmpdir(), "stor-eval-st");
  try {
    const d = resolveStagingTracesDirectory();
    assert.ok(d.replace(/\\/g, "/").includes("eval-sets/traces"));
    assert.ok(d.startsWith(process.env.STORAGE_PATH));
  } finally {
    if (prevS !== undefined) process.env.STORAGE_PATH = prevS;
    else delete process.env.STORAGE_PATH;
    if (prevE !== undefined) process.env.EVAL_STAGING_TRACES_DIR = prevE;
    else delete process.env.EVAL_STAGING_TRACES_DIR;
  }
});

test("listStagingTraceSummaries lists json files from EVAL_STAGING_TRACES_DIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-tr-"));
  writeFileSync(join(dir, "one.json"), "{}");
  writeFileSync(join(dir, "skip.txt"), "x");
  const prev = process.env.EVAL_STAGING_TRACES_DIR;
  process.env.EVAL_STAGING_TRACES_DIR = dir;
  try {
    const traces = listStagingTraceSummaries();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].name, "one.json");
    assert.ok(typeof traces[0].stagingTraceFile === "string");
    assert.ok(traces[0].bytes >= 2);
  } finally {
    if (prev === undefined) delete process.env.EVAL_STAGING_TRACES_DIR;
    else process.env.EVAL_STAGING_TRACES_DIR = prev;
    rmSync(dir, { recursive: true });
  }
});
