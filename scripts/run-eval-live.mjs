#!/usr/bin/env node
/**
 * Optional live eval against a running server (skips when EVAL_LIVE is not set).
 * Set EVAL_LIVE=1, BASE_URL (default http://127.0.0.1:3000), and API_KEY / Bearer as needed.
 */
const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const key = process.env.API_KEY || process.env.SISKELBOT_API_KEY || process.env.ADMIN_API_KEY || "";

if (process.env.EVAL_LIVE !== "1") {
  console.log("run-eval-live: skipped (set EVAL_LIVE=1, BASE_URL, and auth env to run against a live server)");
  process.exit(0);
}

const headers = { "Content-Type": "application/json", Accept: "application/json" };
if (key) {
  headers.Authorization = `Bearer ${key}`;
  headers["x-api-key"] = key;
}

const res = await fetch(`${base}/api/v1/eval/run`, {
  method: "POST",
  headers,
  body: JSON.stringify({ evalSetId: "example" }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}
if (!res.ok) {
  console.error("run-eval-live: HTTP", res.status, body);
  process.exit(1);
}
console.log("run-eval-live: example set", { passed: body.passed, total: body.total, skipped: body.skipped });
const failed = (body.results || []).filter((r) => !r.skipped && !r.pass);
if (failed.length) {
  for (const r of failed) console.error("  FAIL", r.caseId, r.reason || "");
  process.exit(1);
}
process.exit(0);
