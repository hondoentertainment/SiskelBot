#!/usr/bin/env node
/**
 * Export a model card as markdown via the admin API (publish surface).
 *
 *   BASE_URL=https://siskelbot.vercel.app ADMIN_API_KEY=... \
 *     node scripts/export-model-card.mjs <modelId> [out.md]
 */
const base = (process.env.BASE_URL || process.env.SISKELBOT_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const key = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
const modelId = process.argv[2];
const out = process.argv[3];

if (!modelId) {
  console.error("Usage: node scripts/export-model-card.mjs <modelId> [out.md]");
  process.exit(1);
}

const headers = { Accept: "text/markdown, application/json" };
if (key) headers.Authorization = `Bearer ${key}`;

const res = await fetch(`${base}/api/v1/model-cards/${encodeURIComponent(modelId)}/markdown`, {
  headers,
});
const text = await res.text();
if (!res.ok) {
  console.error(text || `HTTP ${res.status}`);
  process.exit(1);
}
if (out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, text, "utf8");
  console.log(`Wrote ${out}`);
} else {
  process.stdout.write(text);
}
