import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAssetManifest,
  assetUrl,
  assetMiddleware,
  scriptTag,
  invalidateManifestCache,
} from "../lib/asset-fingerprint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DIST_DIR = join(ROOT, "client", "dist");
const MANIFEST_PATH = join(DIST_DIR, "manifest.json");

// --- Fixture helpers ---

function withManifest(data, fn) {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  let hadFile = false;
  if (existsSync(MANIFEST_PATH)) {
    hadFile = true;
    origContent = readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify(data));

  try {
    return fn();
  } finally {
    invalidateManifestCache();
    if (hadFile && origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else if (!hadFile && existsSync(MANIFEST_PATH)) {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
}

// --- Helper: mock Express req/res ---

function mockReq(path, query = {}) {
  return { path, query };
}

function mockRes() {
  const headers = {};
  const removed = new Set();
  return {
    headers,
    removed,
    setHeader(key, value) {
      headers[key] = value;
    },
    removeHeader(key) {
      delete headers[key];
      removed.add(key);
    },
  };
}

// --- getAssetManifest ---

test("asset-fingerprint: getAssetManifest returns empty object when no manifest", () => {
  invalidateManifestCache();
  // Temporarily remove manifest if it exists
  let origContent = null;
  let hadFile = false;
  if (existsSync(MANIFEST_PATH)) {
    hadFile = true;
    origContent = readFileSync(MANIFEST_PATH, "utf8");
    rmSync(MANIFEST_PATH);
  }

  try {
    const manifest = getAssetManifest();
    assert.equal(typeof manifest, "object");
    assert.ok(manifest !== null);
    assert.deepEqual(manifest, {});
  } finally {
    invalidateManifestCache();
    if (hadFile && origContent !== null) {
      mkdirSync(DIST_DIR, { recursive: true });
      writeFileSync(MANIFEST_PATH, origContent);
    }
  }
});

test("asset-fingerprint: getAssetManifest reads manifest.json", () => {
  const testData = { "modules.js": "abc123def456", "styles.css": "789xyz" };
  withManifest(testData, () => {
    const manifest = getAssetManifest();
    assert.deepEqual(manifest, testData);
  });
});

test("asset-fingerprint: getAssetManifest caches the result", () => {
  withManifest({ "test.js": "aaa" }, () => {
    const m1 = getAssetManifest();
    const m2 = getAssetManifest();
    assert.equal(m1, m2, "Should return same cached object reference");
  });
});

// --- assetUrl ---

test("asset-fingerprint: assetUrl returns versioned URL when hash exists", () => {
  withManifest({ "modules.js": "abc123" }, () => {
    const url = assetUrl("modules.js");
    assert.equal(url, "/dist/modules.js?v=abc123");
  });
});

test("asset-fingerprint: assetUrl returns plain URL when no hash", () => {
  withManifest({}, () => {
    const url = assetUrl("unknown.js");
    assert.equal(url, "/dist/unknown.js");
  });
});

// --- assetMiddleware ---

test("asset-fingerprint: middleware sets immutable cache for versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc123" });
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.ok(nextCalled);
});

test("asset-fingerprint: middleware sets short cache for non-versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", {});
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(res.headers["Cache-Control"], "public, max-age=300, must-revalidate");
  assert.ok(nextCalled);
});

test("asset-fingerprint: middleware skips non-dist paths", () => {
  const mw = assetMiddleware();
  const req = mockReq("/api/health", {});
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
  assert.ok(!("Cache-Control" in res.headers), "Should not set Cache-Control for non-dist paths");
});

test("asset-fingerprint: middleware sets nosniff for JS files", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc" });
  const res = mockRes();

  mw(req, res, () => {});

  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("asset-fingerprint: middleware removes Pragma for versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc" });
  const res = mockRes();
  res.setHeader("Pragma", "no-cache");

  mw(req, res, () => {});

  assert.ok(res.removed.has("Pragma"));
});

// --- scriptTag ---

test("asset-fingerprint: scriptTag generates correct HTML", () => {
  withManifest({ "app.js": "xyz789" }, () => {
    const tag = scriptTag("app.js");
    assert.equal(tag, '<script src="/dist/app.js?v=xyz789"></script>');
  });
});

test("asset-fingerprint: scriptTag includes additional attributes", () => {
  withManifest({ "app.js": "xyz789" }, () => {
    const tag = scriptTag("app.js", { defer: true, type: "module" });
    assert.ok(tag.includes("defer"));
    assert.ok(tag.includes('type="module"'));
    assert.ok(tag.includes("/dist/app.js?v=xyz789"));
  });
});

// --- invalidateManifestCache ---

test("asset-fingerprint: invalidateManifestCache forces reload", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  let hadFile = false;
  if (existsSync(MANIFEST_PATH)) {
    hadFile = true;
    origContent = readFileSync(MANIFEST_PATH, "utf8");
  }

  try {
    invalidateManifestCache();
    writeFileSync(MANIFEST_PATH, JSON.stringify({ "a.js": "111" }));
    const m1 = getAssetManifest();
    assert.equal(m1["a.js"], "111");

    // Update the manifest and invalidate
    writeFileSync(MANIFEST_PATH, JSON.stringify({ "a.js": "222" }));
    invalidateManifestCache();
    const m2 = getAssetManifest();
    assert.equal(m2["a.js"], "222");
  } finally {
    invalidateManifestCache();
    if (hadFile && origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else if (existsSync(MANIFEST_PATH)) {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});
