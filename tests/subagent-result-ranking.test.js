import test from "node:test";
import assert from "node:assert/strict";
import { heuristicScore, judgeScore, rankResults } from "../lib/subagent-result-ranking.js";

// ---------------------------------------------------------------------------
// heuristicScore
// ---------------------------------------------------------------------------

test("heuristicScore: long structured result scores higher than short vague result", () => {
  const structured = [
    "# Analysis Report",
    "",
    "## Key Findings",
    "",
    "- Revenue increased by 23% in 2024-01-15 quarter",
    "- Customer retention rate is 91.5%",
    "- John Smith led the initiative across New York and London offices",
    "",
    "## Detailed Breakdown",
    "",
    "1. Market analysis showed strong growth patterns",
    "2. Technical implementation completed on schedule",
    "",
    "> The overall outcome exceeded expectations.",
    "",
    "```json",
    '{ "growth": 23, "retention": 91.5 }',
    "```",
  ].join("\n");

  const vague = "Here is some info about the topic.";

  const structuredScore = heuristicScore(structured);
  const vagueScore = heuristicScore(vague);

  assert.ok(structuredScore > vagueScore, `structured (${structuredScore}) should be > vague (${vagueScore})`);
  assert.ok(structuredScore > 0.5, `structured score (${structuredScore}) should be > 0.5`);
});

test("heuristicScore: 'I don't know' result is penalized", () => {
  const confident = "The capital of France is Paris, a city of approximately 2.1 million people.";
  const uncertain = "I don't know the answer to that question. I'm not sure what you're asking about.";

  const confidentScore = heuristicScore(confident);
  const uncertainScore = heuristicScore(uncertain);

  assert.ok(confidentScore > uncertainScore, `confident (${confidentScore}) should be > uncertain (${uncertainScore})`);
});

test("heuristicScore: multiple penalty phrases reduce score further", () => {
  const onePenalty = "I don't know the details, but the project started in 2024-03-01.";
  const manyPenalties = "I don't know. I'm not sure. I cannot help. Unable to provide information.";

  const oneScore = heuristicScore(onePenalty);
  const manyScore = heuristicScore(manyPenalties);

  assert.ok(oneScore > manyScore, `one penalty (${oneScore}) should be > many penalties (${manyScore})`);
});

test("heuristicScore: empty string returns 0", () => {
  assert.equal(heuristicScore(""), 0);
  assert.equal(heuristicScore("   "), 0);
});

test("heuristicScore: null/undefined coerced gracefully", () => {
  assert.equal(heuristicScore(null), 0);
  assert.equal(heuristicScore(undefined), 0);
});

test("heuristicScore: score is always in [0, 1]", () => {
  const veryLong = "x".repeat(10000);
  const score = heuristicScore(veryLong);
  assert.ok(score >= 0 && score <= 1, `score ${score} should be in [0, 1]`);
});

test("heuristicScore: specificity signals boost score", () => {
  const generic = "The system works well and handles many cases effectively.";
  const specific = "The system processed 1,247 requests on 2024-06-15 with a 99.2% success rate at the New York data center.";

  const genericScore = heuristicScore(generic);
  const specificScore = heuristicScore(specific);

  assert.ok(specificScore > genericScore, `specific (${specificScore}) should be > generic (${genericScore})`);
});

// ---------------------------------------------------------------------------
// rankResults (heuristic mode)
// ---------------------------------------------------------------------------

test("rankResults with heuristic: returns sorted results, best is highest", async () => {
  const results = [
    "Short answer.",
    "# Detailed Report\n\n- Point 1 with 42% improvement\n- Point 2 on 2024-01-01\n\n## Summary\n\nJohn Smith completed the project successfully.\n\n```code\nresult = true\n```",
    "I don't know the answer.",
  ];

  const { ranked, best } = await rankResults(results);

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[2].rank, 3);
  assert.ok(ranked[0].score >= ranked[1].score, "rank 1 score >= rank 2 score");
  assert.ok(ranked[1].score >= ranked[2].score, "rank 2 score >= rank 3 score");
  assert.equal(best, ranked[0].result);
  // The detailed report should be ranked first
  assert.ok(best.includes("Detailed Report"), "best result should be the detailed one");
});

test("rankResults with empty array", async () => {
  const { ranked, best } = await rankResults([]);
  assert.deepEqual(ranked, []);
  assert.equal(best, "");
});

test("rankResults with single result", async () => {
  const { ranked, best } = await rankResults(["only one"]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].rank, 1);
  assert.equal(best, "only one");
});

// ---------------------------------------------------------------------------
// rankResults with mocked judge
// ---------------------------------------------------------------------------

test("rankResults with mocked judge: uses judge scores when available", async () => {
  const results = ["Result A (short)", "Result B (also short)"];

  // Mock backendFetch that returns judge scores favoring index 1
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { index: 0, score: 0.3, reason: "too brief" },
              { index: 1, score: 0.9, reason: "comprehensive" },
            ]),
          },
        },
      ],
    }),
  });

  const { ranked, best } = await rankResults(results, {
    judge: true,
    goal: "Summarize the architecture",
    backendFetch: mockFetch,
  });

  assert.equal(ranked.length, 2);
  assert.equal(best, "Result B (also short)");
  assert.equal(ranked[0].score, 0.9);
  assert.equal(ranked[1].score, 0.3);
});

// ---------------------------------------------------------------------------
// judgeScore
// ---------------------------------------------------------------------------

test("judgeScore with malformed LLM response: falls back to heuristic", async () => {
  const results = [
    "# Good detailed answer\n\n- point 1\n- point 2\n\nWith 95% confidence on 2024-05-01.",
    "bad",
  ];

  // Mock that returns unparseable garbage
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "This is not JSON at all, sorry!" } }],
    }),
  });

  const scored = await judgeScore(results, "test goal", mockFetch);

  assert.equal(scored.length, 2);
  // Should fall back to heuristic, so the detailed answer should score higher
  assert.ok(scored[0].score > scored[1].score, "heuristic fallback should rank detailed higher");
});

test("judgeScore with HTTP error: falls back to heuristic", async () => {
  const results = ["answer one", "answer two"];

  const mockFetch = async () => ({
    ok: false,
    status: 500,
  });

  const scored = await judgeScore(results, "test goal", mockFetch);

  assert.equal(scored.length, 2);
  // Both should have heuristic scores (both similar length/quality)
  assert.ok(scored[0].score >= 0 && scored[0].score <= 1);
  assert.ok(scored[1].score >= 0 && scored[1].score <= 1);
});

test("judgeScore with fetch exception: falls back to heuristic", async () => {
  const results = ["answer"];

  const mockFetch = async () => {
    throw new Error("network failure");
  };

  const scored = await judgeScore(results, "goal", mockFetch);

  assert.equal(scored.length, 1);
  assert.ok(scored[0].score >= 0 && scored[0].score <= 1);
});

test("judgeScore with empty results array", async () => {
  const scored = await judgeScore([], "goal");
  assert.deepEqual(scored, []);
});

test("judgeScore with valid partial judge response fills gaps with heuristic", async () => {
  const results = ["result zero", "result one", "result two"];

  // Judge only returns scores for index 0 and 2, missing index 1
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { index: 0, score: 0.8, reason: "good" },
              { index: 2, score: 0.4, reason: "ok" },
            ]),
          },
        },
      ],
    }),
  });

  const scored = await judgeScore(results, "goal", mockFetch);

  assert.equal(scored.length, 3);
  assert.equal(scored[0].score, 0.8);
  assert.equal(scored[2].score, 0.4);
  // Index 1 should be heuristic-scored (not 0.8 or 0.4)
  assert.ok(scored[1].score >= 0 && scored[1].score <= 1);
});
