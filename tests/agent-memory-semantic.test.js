import test from "node:test";
import assert from "node:assert/strict";
import { semanticMemoryEnabled, blendScores } from "../lib/agent-memory-semantic.js";

test("semanticMemoryEnabled: false when flag off", () => {
  const prev = process.env.AGENT_MEMORY_SEMANTIC;
  delete process.env.AGENT_MEMORY_SEMANTIC;
  try {
    assert.equal(semanticMemoryEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_MEMORY_SEMANTIC = prev;
  }
});

test("semanticMemoryEnabled: false when flag on but no API key", () => {
  const prevFlag = process.env.AGENT_MEMORY_SEMANTIC;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AGENT_MEMORY_SEMANTIC = "1";
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(semanticMemoryEnabled(), false);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_MEMORY_SEMANTIC;
    else process.env.AGENT_MEMORY_SEMANTIC = prevFlag;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
});

test("blendScores: default weighting 0.6/0.4", () => {
  const prev = process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
  delete process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
  try {
    const blended = blendScores(1, 0);
    assert.equal(blended, 0.6);
    const blended2 = blendScores(0, 1);
    assert.ok(Math.abs(blended2 - 0.4) < 0.001);
  } finally {
    if (prev !== undefined) process.env.AGENT_MEMORY_SEMANTIC_WEIGHT = prev;
  }
});

test("blendScores: respects AGENT_MEMORY_SEMANTIC_WEIGHT", () => {
  const prev = process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
  process.env.AGENT_MEMORY_SEMANTIC_WEIGHT = "0.25";
  try {
    const blended = blendScores(1, 0);
    assert.equal(blended, 0.25);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
    else process.env.AGENT_MEMORY_SEMANTIC_WEIGHT = prev;
  }
});

test("blendScores: clamps invalid weights to default", () => {
  const prev = process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
  process.env.AGENT_MEMORY_SEMANTIC_WEIGHT = "2.5";
  try {
    const blended = blendScores(1, 0);
    assert.equal(blended, 0.6); // falls back to default
  } finally {
    if (prev === undefined) delete process.env.AGENT_MEMORY_SEMANTIC_WEIGHT;
    else process.env.AGENT_MEMORY_SEMANTIC_WEIGHT = prev;
  }
});
