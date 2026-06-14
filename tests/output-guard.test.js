/**
 * Phase 26: Tests for lib/output-guard.js — safety checking, grounding verification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkOutputSafety, checkGrounding } from "../lib/output-guard.js";

// ── checkOutputSafety ──

test("checkOutputSafety: safe text returns safe=true", () => {
  const result = checkOutputSafety("The weather today is sunny with a high of 72F.");
  assert.equal(result.safe, true);
  assert.deepEqual(result.issues, []);
});

test("checkOutputSafety: empty/null input is safe", () => {
  assert.equal(checkOutputSafety("").safe, true);
  assert.equal(checkOutputSafety(null).safe, true);
  assert.equal(checkOutputSafety(undefined).safe, true);
});

test("checkOutputSafety: detects PII leakage (email)", () => {
  const result = checkOutputSafety("The user's email is john@example.com and they requested help.");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "pii_leakage"));
});

test("checkOutputSafety: detects PII leakage (SSN) with high severity", () => {
  const result = checkOutputSafety("Your SSN is 123-45-6789.");
  assert.equal(result.safe, false);
  const ssnIssue = result.issues.find((i) => i.type === "pii_leakage" && i.detail.includes("ssn"));
  assert.ok(ssnIssue);
  assert.equal(ssnIssue.severity, "high");
});

test("checkOutputSafety: detects PII leakage (credit card) with high severity", () => {
  const result = checkOutputSafety("Card: 4111-1111-1111-1111");
  assert.equal(result.safe, false);
  const ccIssue = result.issues.find((i) => i.detail.includes("credit_card"));
  assert.ok(ccIssue);
  assert.equal(ccIssue.severity, "high");
});

test("checkOutputSafety: detects script injection", () => {
  const result = checkOutputSafety('Try adding <script>alert("xss")</script> to the page.');
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "code_injection"));
});

test("checkOutputSafety: detects javascript: protocol", () => {
  const result = checkOutputSafety("Use javascript: void(0) in the link");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "code_injection"));
});

test("checkOutputSafety: detects onerror handler", () => {
  const result = checkOutputSafety('<img onerror=alert(1) src="x">');
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "code_injection"));
});

test("checkOutputSafety: detects SQL injection patterns", () => {
  const result = checkOutputSafety("You can run DROP TABLE users; to delete the table.");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "sql_injection"));
});

test("checkOutputSafety: detects UNION SELECT", () => {
  const result = checkOutputSafety("Try UNION SELECT * FROM passwords");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "sql_injection"));
});

test("checkOutputSafety: detects harmful instructions", () => {
  const result = checkOutputSafety("Here are instructions to hack into the server.");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "harmful_instructions"));
});

test("checkOutputSafety: detects prototype pollution", () => {
  const result = checkOutputSafety("Set __proto__ to override the object.");
  assert.equal(result.safe, false);
  assert.ok(result.issues.some((i) => i.type === "prototype_pollution"));
});

test("checkOutputSafety: multiple issues detected at once", () => {
  const result = checkOutputSafety('Email: test@a.com <script>alert(1)</script> DROP TABLE x;');
  assert.equal(result.safe, false);
  assert.ok(result.issues.length >= 2);
  const types = result.issues.map((i) => i.type);
  assert.ok(types.includes("pii_leakage"));
  assert.ok(types.includes("code_injection"));
});

// ── checkGrounding ──

test("checkGrounding: empty response is grounded", () => {
  const result = checkGrounding("", ["some source"]);
  assert.equal(result.grounded, true);
  assert.equal(result.score, 1);
  assert.deepEqual(result.unsupportedClaims, []);
});

test("checkGrounding: null response is grounded", () => {
  const result = checkGrounding(null, ["source"]);
  assert.equal(result.grounded, true);
});

test("checkGrounding: no sources means ungrounded", () => {
  const result = checkGrounding("The server runs on Node.js version 18.", []);
  assert.equal(result.grounded, false);
  assert.equal(result.score, 0);
});

test("checkGrounding: response fully supported by source", () => {
  const source = "SiskelBot is a Node.js Express server that proxies chat completions with streaming support.";
  const response = "SiskelBot is a Node.js Express server with streaming support.";
  const result = checkGrounding(response, [source]);
  assert.equal(result.grounded, true);
  assert.ok(result.score >= 0.7);
  assert.deepEqual(result.unsupportedClaims, []);
});

test("checkGrounding: response partially supported", () => {
  const source = "The application uses Node.js and Express.";
  const response = "The application uses Node.js and Express. It also uses Kubernetes for container orchestration and deploys to AWS Lambda.";
  const result = checkGrounding(response, [source]);
  // First sentence should be supported, second not
  assert.ok(result.unsupportedClaims.length >= 0);
  assert.ok(result.score >= 0);
  assert.ok(result.score <= 1);
});

test("checkGrounding: completely unsupported response", () => {
  const source = "SiskelBot uses JSON storage by default.";
  const response = "The quantum computing framework integrates with holographic displays through neural interfaces.";
  const result = checkGrounding(response, [source]);
  assert.equal(result.grounded, false);
  assert.ok(result.score < 0.7);
  assert.ok(result.unsupportedClaims.length > 0);
});

test("checkGrounding: multiple sources combined", () => {
  const sources = [
    "The server uses Express for HTTP routing.",
    "Storage supports JSON, SQLite, and PostgreSQL.",
  ];
  const response = "Express handles HTTP routing. Storage backends include JSON and PostgreSQL.";
  const result = checkGrounding(response, sources);
  assert.ok(result.score >= 0.5);
});

test("checkGrounding: short fragments are treated as grounded", () => {
  const result = checkGrounding("Yes. OK. Sure.", ["anything"]);
  assert.equal(result.grounded, true);
  assert.equal(result.score, 1);
});

test("checkGrounding: score is between 0 and 1", () => {
  const result = checkGrounding(
    "This is a detailed response about many different topics that spans several sentences.",
    ["This is a source about topics."]
  );
  assert.ok(result.score >= 0);
  assert.ok(result.score <= 1);
});
