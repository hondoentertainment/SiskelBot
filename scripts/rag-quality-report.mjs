#!/usr/bin/env node
/**
 * RAG quality report: measures precision@3 and MRR across a built-in test set.
 * Usage: node scripts/rag-quality-report.mjs [--workspace <id>] [--limit <n>] [--output <file.json>]
 * Exits 1 if average precision@3 < 0.5.
 */
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { semanticSearch } from "../lib/knowledge-store.js";

const TEST_QUESTIONS = [
  "What is the capital of France?",
  "How does OAuth2 authorization code flow work?",
  "What are the main features of Node.js?",
  "How do you configure environment variables in Docker?",
  "What is a REST API and how does it differ from GraphQL?",
  "How does cosine similarity measure vector distance?",
  "What is the purpose of an API gateway?",
  "How do embeddings represent text semantically?",
];

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "default" },
    limit: { type: "string", default: "0" },
    output: { type: "string", default: "" },
  },
  strict: false,
});

const workspace = values.workspace || "default";
const limit = Number(values.limit) || 0;
const outputFile = values.output || "";

const questions = limit > 0 ? TEST_QUESTIONS.slice(0, limit) : TEST_QUESTIONS;
const threshold = Number(process.env.RAG_RELEVANCE_THRESHOLD) || 0.7;

const isRelevant = (s) => s.score >= threshold;

const precisionAtK = (snippets, k) => {
  const slice = snippets.slice(0, k);
  if (slice.length === 0) return 0;
  return slice.filter(isRelevant).length / slice.length;
};

const computeMrr = (snippets) => {
  for (let i = 0; i < snippets.length; i++) {
    if (isRelevant(snippets[i])) return 1 / (i + 1);
  }
  return 0;
};

const rows = [];
let noData = true;

for (const q of questions) {
  const result = await semanticSearch({ query: q, workspace, topK: 5 });

  if (result.error) {
    if (result.code === "EMBEDDINGS_UNAVAILABLE") {
      console.log("No knowledge data found, skipping");
      process.exit(0);
    }
    console.warn(`Search error for "${q}": ${result.error}`);
    continue;
  }

  const snippets = result.snippets || [];
  if (snippets.length > 0) noData = false;

  const p3 = precisionAtK(snippets, 3);
  const mrr = computeMrr(snippets);
  const topScore = snippets[0]?.score ?? 0;

  rows.push({ query: q, precisionAt3: p3, mrr, topChunkScore: topScore });
}

if (noData) {
  console.log("No knowledge data found, skipping");
  process.exit(0);
}

const avgP3 = rows.length > 0 ? rows.reduce((s, r) => s + r.precisionAt3, 0) / rows.length : 0;
const avgMrr = rows.length > 0 ? rows.reduce((s, r) => s + r.mrr, 0) / rows.length : 0;

const header = "| Query | Precision@3 | MRR | Top chunk score |";
const sep    = "|-------|-------------|-----|-----------------|";
const tableRows = rows.map((r) =>
  `| ${r.query.slice(0, 50)} | ${r.precisionAt3.toFixed(3)} | ${r.mrr.toFixed(3)} | ${r.topChunkScore.toFixed(3)} |`
);

console.log("\n## RAG Quality Report\n");
console.log(header);
console.log(sep);
for (const row of tableRows) console.log(row);
console.log(`\n**Average Precision@3**: ${avgP3.toFixed(3)}  **Average MRR**: ${avgMrr.toFixed(3)}\n`);

if (outputFile) {
  await writeFile(outputFile, JSON.stringify({ avgPrecisionAt3: avgP3, avgMrr, rows }, null, 2));
  console.log(`Results written to ${outputFile}`);
}

if (avgP3 < 0.5) {
  console.warn(`WARNING: Average precision@3 (${avgP3.toFixed(3)}) is below the 0.5 threshold.`);
  process.exit(1);
}

process.exit(0);
