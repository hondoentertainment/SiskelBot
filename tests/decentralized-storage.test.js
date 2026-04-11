/**
 * Phase 48.5: Decentralized storage abstraction tests.
 *
 * Covers CID computation, mock uploader/downloader roundtrips, pin lifecycle,
 * archive of knowledge documents, provider health, and pluggable providers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted state does not pollute the
// project data dir or leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-dstorage-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  PROVIDERS,
  computeCid,
  isValidCid,
  uploadToStorage,
  downloadFromStorage,
  pinContent,
  unpinContent,
  listPinnedContent,
  archiveKnowledgeDocument,
  restoreFromDecentralized,
  checkProviderHealth,
  registerStorageProvider,
  listProviders,
  mockUploader,
  mockDownloader,
  _internals,
} = await import("../lib/decentralized-storage.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test.beforeEach(() => {
  _internals.resetMockStore();
});

// ---- CID ----

test("computeCid returns deterministic identifiers for the same input", () => {
  const a = computeCid("hello world");
  const b = computeCid("hello world");
  assert.equal(a, b);
  assert.ok(a.startsWith("b"));
  assert.ok(isValidCid(a));
});

test("computeCid produces different CIDs for different data", () => {
  const a = computeCid("one");
  const b = computeCid("two");
  assert.notEqual(a, b);
});

test("computeCid throws when data is missing", () => {
  assert.throws(() => computeCid(null), /data is required/);
});

test("isValidCid rejects obviously invalid strings", () => {
  assert.equal(isValidCid(""), false);
  assert.equal(isValidCid("abc"), false); // too short
  assert.equal(isValidCid("X".repeat(200)), false); // too long
  assert.equal(isValidCid("1notbase32"), false); // leading digit
  assert.equal(isValidCid("bINVALID"), false); // uppercase
  const good = computeCid("valid content");
  assert.equal(isValidCid(good), true);
});

// ---- Upload / download ----

test("uploadToStorage with mock provider returns a CID and size", async () => {
  const result = await uploadToStorage("hello mock", { provider: "mock" });
  assert.ok(result.cid);
  assert.ok(isValidCid(result.cid));
  assert.equal(result.provider, "mock");
  assert.equal(result.size, Buffer.byteLength("hello mock", "utf8"));
  assert.ok(result.uploadedAt > 0);
  assert.ok(result.url?.startsWith("mock://"));
});

test("uploadToStorage defaults to the mock provider when omitted", async () => {
  const result = await uploadToStorage("default provider content");
  assert.equal(result.provider, "mock");
});

test("downloadFromStorage retrieves data previously uploaded", async () => {
  const { cid } = await uploadToStorage("roundtrip payload", { provider: "mock" });
  const out = await downloadFromStorage(cid, { provider: "mock" });
  assert.equal(out.data, "roundtrip payload");
  assert.equal(out.verified, true);
  assert.equal(out.provider, "mock");
});

test("upload + download roundtrip preserves multi-line content", async () => {
  const content = "line 1\nline 2\nline 3\n";
  const { cid } = await uploadToStorage(content, { provider: "mock" });
  const out = await downloadFromStorage(cid, { provider: "mock" });
  assert.equal(out.data, content);
  assert.equal(out.verified, true);
});

test("uploadToStorage with metadata preserves metadata in the mock store", async () => {
  const metadata = { author: "alice", tags: ["test", "phase48.5"] };
  const { cid } = await uploadToStorage("content with meta", {
    provider: "mock",
    metadata,
  });
  const entry = _internals.mockStore.get(cid);
  assert.ok(entry);
  assert.deepEqual(entry.metadata, metadata);
});

test("downloadFromStorage throws INVALID_CID for bogus identifiers", async () => {
  await assert.rejects(
    () => downloadFromStorage("not-a-cid", { provider: "mock" }),
    (e) => e.code === "INVALID_CID",
  );
});

test("downloadFromStorage of unknown cid surfaces NOT_FOUND", async () => {
  // A valid-shape CID that was never uploaded.
  const cid = computeCid("never uploaded");
  await assert.rejects(
    () => downloadFromStorage(cid, { provider: "mock" }),
    (e) => e.code === "NOT_FOUND",
  );
});

test("uploadToStorage throws on unknown provider", async () => {
  await assert.rejects(
    () => uploadToStorage("hi", { provider: "does-not-exist" }),
    /unknown provider/,
  );
});

// ---- Pins ----

test("uploadToStorage creates a pin record by default", async () => {
  const { cid } = await uploadToStorage("pinned on upload", {
    provider: "mock",
    workspaceId: "ws-a",
  });
  const pinned = await listPinnedContent({ workspaceId: "ws-a" });
  assert.ok(pinned.some((p) => p.cid === cid));
});

test("pinContent creates a pin record for an existing CID", async () => {
  const cid = computeCid("content to pin manually");
  const pin = await pinContent(cid, "mock");
  assert.equal(pin.cid, cid);
  assert.equal(pin.provider, "mock");
  assert.ok(pin.pinnedAt > 0);
});

test("unpinContent removes the pin record and is idempotent", async () => {
  const cid = computeCid("content to unpin");
  await pinContent(cid, "mock");
  const first = await unpinContent(cid);
  assert.equal(first.removed, true);
  const second = await unpinContent(cid);
  assert.equal(second.removed, false);
});

test("listPinnedContent filters by provider and workspaceId", async () => {
  const a = await uploadToStorage("a", { provider: "mock", workspaceId: "ws1" });
  const b = await uploadToStorage("b", { provider: "mock", workspaceId: "ws2" });
  const byWs1 = await listPinnedContent({ workspaceId: "ws1" });
  assert.ok(byWs1.some((p) => p.cid === a.cid));
  assert.ok(!byWs1.some((p) => p.cid === b.cid));
  const byMock = await listPinnedContent({ provider: "mock" });
  assert.ok(byMock.some((p) => p.cid === a.cid));
  assert.ok(byMock.some((p) => p.cid === b.cid));
});

// ---- Knowledge archive ----

test("archiveKnowledgeDocument persists a pin record with the given content", async () => {
  const res = await archiveKnowledgeDocument("doc-1", "ws-arch", {
    provider: "mock",
    content: "full document body here",
    title: "My Doc",
  });
  assert.ok(res.cid);
  assert.equal(res.docId, "doc-1");
  assert.equal(res.workspaceId, "ws-arch");
  assert.equal(res.provider, "mock");
  assert.ok(res.archivedAt > 0);
  const pinned = await listPinnedContent({ workspaceId: "ws-arch" });
  assert.ok(pinned.some((p) => p.cid === res.cid));
});

test("restoreFromDecentralized decodes the archived payload", async () => {
  const original = "body of archived doc";
  const res = await archiveKnowledgeDocument("doc-2", "ws-restore", {
    provider: "mock",
    content: original,
    title: "Restore Me",
    metadata: { lang: "en" },
  });
  const restored = await restoreFromDecentralized(res.cid, "mock");
  assert.equal(restored.cid, res.cid);
  assert.equal(restored.provider, "mock");
  assert.equal(restored.verified, true);
  assert.equal(restored.document.docId, "doc-2");
  assert.equal(restored.document.workspaceId, "ws-restore");
  assert.equal(restored.document.content, original);
  assert.equal(restored.document.title, "Restore Me");
});

// ---- Provider health ----

test("checkProviderHealth returns ok for the mock provider", async () => {
  const h = await checkProviderHealth("mock");
  assert.equal(h.provider, "mock");
  assert.equal(h.ok, true);
  assert.equal(typeof h.latencyMs, "number");
});

test("checkProviderHealth rejects unknown providers", async () => {
  await assert.rejects(() => checkProviderHealth("ghost"), /unknown provider/);
});

// ---- Pluggability ----

test("registerStorageProvider allows custom uploader and downloader", async () => {
  const store = new Map();
  registerStorageProvider(
    "custom",
    { type: "memory", description: "custom in-memory" },
    async (data) => {
      const cid = computeCid(data);
      store.set(cid, data);
      return { cid, size: Buffer.byteLength(String(data), "utf8"), url: `custom://${cid}` };
    },
    async (cid) => {
      if (!store.has(cid)) {
        const err = new Error("missing");
        err.code = "NOT_FOUND";
        throw err;
      }
      return { data: store.get(cid), metadata: {} };
    },
  );
  const up = await uploadToStorage("custom payload", { provider: "custom" });
  assert.equal(up.provider, "custom");
  const down = await downloadFromStorage(up.cid, { provider: "custom" });
  assert.equal(down.data, "custom payload");
  assert.equal(down.verified, true);
  const providers = listProviders();
  assert.ok(providers.some((p) => p.name === "custom"));
});

test("registerStorageProvider rejects invalid arguments", () => {
  assert.throws(() => registerStorageProvider("", {}, async () => {}, async () => {}), /name is required/);
  assert.throws(() => registerStorageProvider("x", {}, null, async () => {}), /uploader must be a function/);
  assert.throws(() => registerStorageProvider("x", {}, async () => {}, null), /downloader must be a function/);
});

test("PROVIDERS built-ins include ipfs, arweave, web3storage, and mock", () => {
  assert.ok(PROVIDERS.ipfs);
  assert.ok(PROVIDERS.arweave);
  assert.ok(PROVIDERS.web3storage);
  assert.ok(PROVIDERS.mock);
  assert.equal(PROVIDERS.ipfs.type, "ipfs");
  assert.equal(PROVIDERS.arweave.type, "arweave");
});

test("mockUploader and mockDownloader can be used directly", async () => {
  const up = await mockUploader("direct-use", {});
  assert.ok(up.cid);
  const down = await mockDownloader(up.cid);
  assert.equal(down.data, "direct-use");
});
