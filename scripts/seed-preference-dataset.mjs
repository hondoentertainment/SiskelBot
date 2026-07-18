#!/usr/bin/env node
/**
 * Seed a preference dataset from data/preference-datasets/seed-example.json
 * (or --file PATH). Uses lib storage; no live server required.
 *
 *   node scripts/seed-preference-dataset.mjs
 *   node scripts/seed-preference-dataset.mjs --file data/preference-datasets/seed-example.json
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPreferenceDataset,
  addPreferencePair,
} from "../lib/preference-dataset.js";

const args = process.argv.slice(2);
let file = "data/preference-datasets/seed-example.json";
const fi = args.indexOf("--file");
if (fi >= 0 && args[fi + 1]) file = args[fi + 1];

const raw = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
const workspaceId = raw.workspaceId || "default";
const dataset = await createPreferenceDataset(raw.name || "seed", workspaceId, {
  description: raw.description || "",
  sourceType: "manual",
  format: raw.format || "dpo",
});
if (dataset.error) {
  console.error(dataset);
  process.exit(1);
}

let added = 0;
for (const pair of raw.pairs || []) {
  const r = await addPreferencePair(dataset.id, pair, workspaceId);
  if (!r.error) added += 1;
  else console.warn("skip pair:", r.error);
}

console.log(
  JSON.stringify(
    { ok: true, datasetId: dataset.id, workspaceId, pairsAdded: added },
    null,
    2,
  ),
);
