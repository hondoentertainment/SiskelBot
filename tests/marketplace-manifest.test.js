import test from "node:test";
import assert from "node:assert/strict";
import { validateMarketplaceManifest } from "../lib/marketplace-manifest.js";

test("validateMarketplaceManifest accepts example shape", () => {
  const r = validateMarketplaceManifest({
    id: "pack.weather",
    version: "1.2.3",
    tools: [
      {
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    signature: {
      algorithm: "ed25519",
      keyId: "key-1",
      value: "base64sig==",
    },
  });
  assert.equal(r.ok, true);
});

test("validateMarketplaceManifest rejects invalid", () => {
  const r = validateMarketplaceManifest({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.includes("E_MANIFEST_ID_REQUIRED")));
  assert.ok(r.errors.some((e) => e.includes("E_MANIFEST_VERSION_REQUIRED")));
});

test("validateMarketplaceManifest rejects non-semver version", () => {
  const r = validateMarketplaceManifest({ id: "pack.bad", version: "1", tools: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("E_MANIFEST_VERSION_SEMVER")));
});

test("validateMarketplaceManifest rejects duplicate tool names", () => {
  const r = validateMarketplaceManifest({
    id: "pack.dupe",
    version: "1.0.0",
    tools: [{ name: "search_docs" }, { name: "search_docs" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("E_TOOL_NAME_DUPLICATE")));
});

test("validateMarketplaceManifest rejects invalid signature shape", () => {
  const r = validateMarketplaceManifest({
    id: "pack.sig",
    version: "1.0.0",
    signature: { algorithm: "", keyId: "", value: "" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("E_SIGNATURE_ALGORITHM_REQUIRED")));
  assert.ok(r.errors.some((e) => e.includes("E_SIGNATURE_KEY_ID_REQUIRED")));
  assert.ok(r.errors.some((e) => e.includes("E_SIGNATURE_VALUE_REQUIRED")));
});
