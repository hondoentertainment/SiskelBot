/**
 * Phase 57: Citation targets and answer checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCitationTargetsFromSearchResult,
  answerReferencesCitation,
  checkCitationCoverage,
} from "../lib/grounding.js";

test("extractCitationTargetsFromSearchResult collects ids and titles", () => {
  const json = JSON.stringify({
    snippets: [
      { id: "doc-1", title: "Alpha", snippet: "x" },
      { id: "doc-2", title: "Beta", snippet: "y" },
    ],
  });
  const { ids, titles } = extractCitationTargetsFromSearchResult(json);
  assert.ok(ids.has("doc-1"));
  assert.ok(titles.has("alpha"));
});

test("answerReferencesCitation matches id substring", () => {
  const ok = answerReferencesCitation("See [doc-1] for details.", new Set(["doc-1"]), new Set());
  assert.equal(ok, true);
});

test("answerReferencesCitation matches title case-insensitive", () => {
  const ok = answerReferencesCitation('Read "alpha" section.', new Set(), new Set(["alpha"]));
  assert.equal(ok, true);
});

test("checkCitationCoverage skipped when citations not required", () => {
  const prev = process.env.AGENT_REQUIRE_CITATIONS;
  process.env.AGENT_REQUIRE_CITATIONS = "";
  try {
    const r = checkCitationCoverage("no cites", [
      { role: "tool", content: '{"snippets":[{"id":"x","title":"T","snippet":"s"}]}' },
    ]);
    assert.equal(r.skipped, true);
  } finally {
    process.env.AGENT_REQUIRE_CITATIONS = prev;
  }
});

test("checkCitationCoverage fails when citations required and answer omits sources", () => {
  const prev = process.env.AGENT_REQUIRE_CITATIONS;
  process.env.AGENT_REQUIRE_CITATIONS = "1";
  try {
    const r = checkCitationCoverage("Generic answer with no ids.", [
      { role: "tool", content: '{"snippets":[{"id":"uuid-abc","title":"My Doc","snippet":"hello"}]}' },
    ]);
    assert.equal(r.ok, false);
    const r2 = checkCitationCoverage("Per uuid-abc we know …", [
      { role: "tool", content: '{"snippets":[{"id":"uuid-abc","title":"My Doc","snippet":"hello"}]}' },
    ]);
    assert.equal(r2.ok, true);
  } finally {
    process.env.AGENT_REQUIRE_CITATIONS = prev;
  }
});

test("checkCitationCoverage bracket mode requires [id] when enabled", () => {
  const prevReq = process.env.AGENT_REQUIRE_CITATIONS;
  const prevBr = process.env.AGENT_CITATION_BRACKET_IDS;
  process.env.AGENT_REQUIRE_CITATIONS = "1";
  process.env.AGENT_CITATION_BRACKET_IDS = "1";
  try {
    const toolMsg = { role: "tool", content: '{"snippets":[{"id":"uuid-abc","title":"My Doc","snippet":"hello"}]}' };
    const bad = checkCitationCoverage("Answer cites uuid-abc in prose only.", [toolMsg]);
    assert.equal(bad.ok, false);
    const good = checkCitationCoverage("See [uuid-abc] for proof.", [toolMsg]);
    assert.equal(good.ok, true);
  } finally {
    process.env.AGENT_REQUIRE_CITATIONS = prevReq;
    process.env.AGENT_CITATION_BRACKET_IDS = prevBr;
  }
});
