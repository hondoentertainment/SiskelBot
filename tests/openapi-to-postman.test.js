import test from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("openapi-to-postman: generates valid v2.1 collection", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptm-"));
  const inputPath = join(dir, "spec.json");
  const outputPath = join(dir, "out.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/health/live": {
          get: { summary: "Liveness probe", tags: ["health"] },
        },
        "/api/v1/conversations": {
          post: {
            summary: "Create conversation",
            tags: ["conversations"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { title: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  execSync(
    `node scripts/openapi-to-postman.mjs --input=${inputPath} --output=${outputPath}`
  );

  const out = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(
    out.info.schema,
    "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  );
  assert.equal(out.item.length, 2); // 2 tags
  assert.ok(out.item.find((g) => g.name === "health"));
  assert.ok(out.item.find((g) => g.name === "conversations"));
});

test("openapi-to-postman: path params become Postman :variable syntax", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptm-"));
  const inputPath = join(dir, "spec.json");
  const outputPath = join(dir, "out.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/api/v1/conversations/{id}": {
          get: {
            summary: "Get conversation",
            tags: ["conversations"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    })
  );

  execSync(
    `node scripts/openapi-to-postman.mjs --input=${inputPath} --output=${outputPath}`
  );

  const out = JSON.parse(readFileSync(outputPath, "utf8"));
  const item = out.item[0].item[0];
  assert.equal(item.request.url.raw, "{{baseUrl}}/api/v1/conversations/:id");
  assert.ok(item.request.url.variable.find((v) => v.key === "id"));
});

test("openapi-to-postman: requestBody schema produces a JSON example body", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptm-"));
  const inputPath = join(dir, "spec.json");
  const outputPath = join(dir, "out.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/api/v1/things": {
          post: {
            summary: "Create thing",
            tags: ["things"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  execSync(
    `node scripts/openapi-to-postman.mjs --input=${inputPath} --output=${outputPath}`
  );

  const out = JSON.parse(readFileSync(outputPath, "utf8"));
  const item = out.item[0].item[0];
  assert.equal(item.request.body.mode, "raw");
  const parsed = JSON.parse(item.request.body.raw);
  assert.equal(typeof parsed.name, "string");
  assert.equal(typeof parsed.count, "number");
});
