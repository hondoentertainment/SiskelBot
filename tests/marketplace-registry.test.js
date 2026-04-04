import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyManifestSignature,
  installMarketplacePack,
  listInstalledMarketplacePacks,
  saveWorkspaceMarketplacePolicy,
  getWorkspaceMarketplacePolicy,
  computeUnsignedManifestDigestHex,
} from "../lib/marketplace-registry.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function signedManifest(base, keyId = "trusted-key") {
  const unsigned = {
    id: base.id,
    version: base.version,
    tools: base.tools || [],
  };
  const stable = stableStringify(unsigned);
  const digest = createHash("sha256").update(stable, "utf8").digest("hex");
  return {
    ...unsigned,
    signature: { algorithm: "sha256", keyId, value: digest },
  };
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

test("computeUnsignedManifestDigestHex matches signed manifest digest", () => {
  const manifest = signedManifest({ id: "pack.digest", version: "2.0.0", tools: [{ name: "t1" }] });
  assert.equal(computeUnsignedManifestDigestHex(manifest), manifest.signature.value);
});

test("verifyManifestSignature rejects when trust store empty", () => {
  const prevStorage = process.env.STORAGE_PATH;
  const dir = mkdtempSync(join(tmpdir(), "market-reg-"));
  process.env.STORAGE_PATH = dir;
  const prev = process.env.MARKETPLACE_TRUSTED_KEY_IDS;
  delete process.env.MARKETPLACE_TRUSTED_KEY_IDS;
  try {
    const manifest = signedManifest({ id: "pack.a", version: "1.0.0" });
    const out = verifyManifestSignature(manifest);
    assert.equal(out.ok, false);
    assert.equal(out.code, "TRUST_STORE_EMPTY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevStorage === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStorage;
    if (prev === undefined) delete process.env.MARKETPLACE_TRUSTED_KEY_IDS;
    else process.env.MARKETPLACE_TRUSTED_KEY_IDS = prev;
  }
});

test("installMarketplacePack installs signed pack and lists it", async () => {
  const prevStorage = process.env.STORAGE_PATH;
  const dir = mkdtempSync(join(tmpdir(), "market-reg-"));
  process.env.STORAGE_PATH = dir;
  const prev = process.env.MARKETPLACE_TRUSTED_KEY_IDS;
  process.env.MARKETPLACE_TRUSTED_KEY_IDS = "trusted-key";
  try {
    const manifest = signedManifest({
      id: "pack.weather",
      version: "1.0.0",
      tools: [{ name: "get_weather" }],
    });
    const out = await installMarketplacePack("default", manifest);
    assert.equal(out.ok, true);
    const list = await listInstalledMarketplacePacks("default");
    assert.ok(list.some((p) => p.id === "pack.weather" && p.version === "1.0.0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevStorage === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStorage;
    if (prev === undefined) delete process.env.MARKETPLACE_TRUSTED_KEY_IDS;
    else process.env.MARKETPLACE_TRUSTED_KEY_IDS = prev;
  }
});

test("workspace marketplace policy round-trip", async () => {
  const prevStorage = process.env.STORAGE_PATH;
  const dir = mkdtempSync(join(tmpdir(), "market-reg-"));
  process.env.STORAGE_PATH = dir;
  try {
    const policy = await saveWorkspaceMarketplacePolicy("default", {
      blockedToolNames: ["deploy"],
      allowedToolNames: ["build"],
    });
    assert.ok(Array.isArray(policy.blockedToolNames));
    const loaded = await getWorkspaceMarketplacePolicy("default");
    assert.ok(loaded.blockedToolNames.includes("deploy"));
    assert.ok(loaded.allowedToolNames.includes("build"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevStorage === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStorage;
  }
});
