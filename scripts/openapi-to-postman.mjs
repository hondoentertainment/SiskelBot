#!/usr/bin/env node
/**
 * Convert OpenAPI spec to a Postman Collection v2.1.
 *
 * Usage:
 *   node scripts/openapi-to-postman.mjs --input=docs/openapi.yaml --output=postman/SiskelBot.postman_collection.json
 *
 * The output is suitable for direct import into Postman / Insomnia / Hoppscotch.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

async function loadYamlParser() {
  try {
    const yaml = await import("yaml");
    const lib = yaml.default || yaml;
    if (typeof lib.parse === "function") return (s) => lib.parse(s);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
  }
  try {
    const jsYaml = await import("js-yaml");
    const lib = jsYaml.default || jsYaml;
    if (typeof lib.load === "function") return (s) => lib.load(s);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
  }
  throw new Error("No YAML parser available. Install `yaml` or `js-yaml`.");
}

async function loadSpec(path) {
  const content = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(content);
  const parse = await loadYamlParser();
  return parse(content);
}

function pathToPostmanUrl(path) {
  // Convert /api/v1/conversations/{id} -> {{baseUrl}}/api/v1/conversations/:id
  const parts = path.split("/").filter(Boolean);
  return {
    raw: `{{baseUrl}}${path.replace(/\{(\w+)\}/g, ":$1")}`,
    host: ["{{baseUrl}}"],
    path: parts.map((p) => p.replace(/\{(\w+)\}/g, ":$1")),
  };
}

function generateExampleFromSchema(schema, depth = 0) {
  if (!schema || depth > 3) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" && schema.properties) {
    const obj = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const ex = generateExampleFromSchema(v, depth + 1);
      if (ex !== undefined) obj[k] = ex;
    }
    return obj;
  }
  if (schema.type === "array" && schema.items) {
    const ex = generateExampleFromSchema(schema.items, depth + 1);
    return ex !== undefined ? [ex] : [];
  }
  if (schema.type === "string") {
    return schema.format === "date-time" ? new Date().toISOString() : "string";
  }
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  return undefined;
}

function buildItem(method, path, op) {
  const url = pathToPostmanUrl(path);
  const item = {
    name: op.summary || `${method.toUpperCase()} ${path}`,
    request: {
      method: method.toUpperCase(),
      header: [
        { key: "Content-Type", value: "application/json" },
        { key: "Authorization", value: "Bearer {{apiKey}}" },
      ],
      url,
      description: op.description || "",
    },
    response: [],
  };

  // Body example
  if (op.requestBody?.content?.["application/json"]) {
    const schema = op.requestBody.content["application/json"].schema;
    const example =
      op.requestBody.content["application/json"].example ||
      generateExampleFromSchema(schema);
    if (example !== undefined) {
      item.request.body = {
        mode: "raw",
        raw: JSON.stringify(example, null, 2),
        options: { raw: { language: "json" } },
      };
    }
  }

  // Path & query params
  if (op.parameters) {
    const queryParams = op.parameters.filter((p) => p.in === "query");
    if (queryParams.length) {
      url.query = queryParams.map((p) => ({
        key: p.name,
        value:
          p.example?.toString() ||
          p.schema?.example?.toString() ||
          "",
        description: p.description || "",
        disabled: !p.required,
      }));
      url.raw += "?" + queryParams.map((p) => `${p.name}=`).join("&");
    }
    const pathParams = op.parameters.filter((p) => p.in === "path");
    if (pathParams.length) {
      url.variable = pathParams.map((p) => ({
        key: p.name,
        value: p.example?.toString() || `:${p.name}`,
        description: p.description || "",
      }));
    }
  }

  return item;
}

function groupByTag(spec) {
  const groups = new Map();
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (method.startsWith("x-")) continue;
      if (!op || typeof op !== "object") continue;
      const tag = op.tags?.[0] || "default";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(buildItem(method, path, op));
    }
  }
  return groups;
}

function buildCollection(spec, name = "SiskelBot") {
  const groups = groupByTag(spec);
  const items = [];
  for (const [tag, ops] of groups.entries()) {
    items.push({ name: tag, item: ops });
  }

  return {
    info: {
      _postman_id: "00000000-0000-0000-0000-000000000001",
      name,
      description: spec.info?.description || "SiskelBot API",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: [
      { key: "baseUrl", value: "https://siskelbot.example.com", type: "string" },
      { key: "apiKey", value: "", type: "string" },
    ],
    auth: {
      type: "bearer",
      bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }],
    },
  };
}

function parseArgs(argv) {
  const args = { input: null, output: null, name: "SiskelBot" };
  for (const a of argv.slice(2)) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "input") args.input = v;
    if (k === "output") args.output = v;
    if (k === "name") args.name = v;
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.input || !args.output) {
  console.error(
    "Usage: openapi-to-postman.mjs --input=<spec.yaml> --output=<collection.json>"
  );
  process.exit(2);
}

const spec = await loadSpec(args.input);
const collection = buildCollection(spec, args.name);
mkdirSync(dirname(args.output), { recursive: true });
writeFileSync(args.output, JSON.stringify(collection, null, 2));

const itemCount = collection.item.reduce((n, g) => n + g.item.length, 0);
console.log(
  `Wrote ${itemCount} requests in ${collection.item.length} folders to ${args.output}`
);
