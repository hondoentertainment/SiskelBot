import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gzipSync, gunzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const AUDIT_LOG_PATH = join(DATA_DIR, "execution-audit.json");
const ARCHIVE_DIR = join(DATA_DIR, "audit-archive");

// Helpers
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeEntries(specs) {
  return specs.map(s => ({
    timestamp: s.timestamp || daysAgo(s.daysAgo || 0),
    action: s.action || "build",
    ok: s.ok !== undefined ? s.ok : true,
    error: s.error || undefined,
    userId: s.userId || undefined,
    workspaceId: s.workspaceId || undefined,
    level: s.level || undefined,
    source: s.source || undefined,
  }));
}

function writeAuditLog(entries) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(AUDIT_LOG_PATH, JSON.stringify(entries, null, 0), "utf8");
}

function cleanUp() {
  try { rmSync(AUDIT_LOG_PATH, { force: true }); } catch {}
  try { rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
}

// Clear S3 env to force local fallback
const s3EnvKeys = ["AUDIT_S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AUDIT_S3_REGION", "AUDIT_S3_PREFIX"];
let savedEnv = {};

function clearS3Env() {
  savedEnv = {};
  for (const k of s3EnvKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const k of s3EnvKeys) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
}

describe("AuditLifecycle", () => {
  beforeEach(() => {
    cleanUp();
    clearS3Env();
  });

  afterEach(() => {
    cleanUp();
    restoreEnv();
  });

  it("configure sets and getRetentionPolicy returns policy", async () => {
    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    lc.configure({ retentionDays: 60, archiveAfterDays: 14, deleteAfterDays: 180, bucketName: "test-bucket" });
    const policy = lc.getRetentionPolicy();
    assert.strictEqual(policy.retentionDays, 60);
    assert.strictEqual(policy.archiveAfterDays, 14);
    assert.strictEqual(policy.deleteAfterDays, 180);
    assert.strictEqual(policy.bucketName, "test-bucket");
  });

  it("getRetentionPolicy returns defaults from env", async () => {
    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    const policy = lc.getRetentionPolicy();
    assert.strictEqual(policy.retentionDays, 90);
    assert.strictEqual(policy.archiveAfterDays, 30);
    assert.strictEqual(policy.deleteAfterDays, 365);
  });

  it("archiveOldEntries moves old entries to local archive", async () => {
    const entries = makeEntries([
      { daysAgo: 45, action: "deploy" },
      { daysAgo: 10, action: "build" },
      { daysAgo: 2, action: "test" },
    ]);
    writeAuditLog(entries);

    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    lc.configure({ archiveAfterDays: 30 });
    const result = await lc.archiveOldEntries();

    assert.strictEqual(result.archived, 1);
    assert.strictEqual(result.remaining, 2);
    assert.ok(result.key);

    // Verify active log has only 2 entries
    const active = JSON.parse(readFileSync(AUDIT_LOG_PATH, "utf8"));
    assert.strictEqual(active.length, 2);

    // Verify archive file exists locally
    assert.ok(existsSync(ARCHIVE_DIR));
    const files = readdirSync(ARCHIVE_DIR);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith(".json.gz"));

    // Verify archived content
    const compressed = readFileSync(join(ARCHIVE_DIR, files[0]));
    const archived = JSON.parse(gunzipSync(compressed).toString("utf8"));
    assert.strictEqual(archived.length, 1);
    assert.strictEqual(archived[0].action, "deploy");
  });

  it("archiveOldEntries returns 0 when nothing to archive", async () => {
    const entries = makeEntries([
      { daysAgo: 1, action: "build" },
    ]);
    writeAuditLog(entries);

    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    lc.configure({ archiveAfterDays: 30 });
    const result = await lc.archiveOldEntries();

    assert.strictEqual(result.archived, 0);
    assert.strictEqual(result.remaining, 1);
  });

  it("archiveOldEntries returns 0 when no audit file", async () => {
    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    const result = await lc.archiveOldEntries();
    assert.strictEqual(result.archived, 0);
  });

  it("purgeExpired deletes old local archives", async () => {
    // Create a fake old archive file
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const ts = oldDate.toISOString().replace(/[:.]/g, "-");
    const filename = `audit-${ts}.json.gz`;
    const data = gzipSync(Buffer.from(JSON.stringify([{ action: "old" }]), "utf8"));
    writeFileSync(join(ARCHIVE_DIR, filename), data);

    // Create a recent archive (should NOT be deleted)
    const recentTs = new Date().toISOString().replace(/[:.]/g, "-");
    const recentFilename = `audit-${recentTs}.json.gz`;
    writeFileSync(join(ARCHIVE_DIR, recentFilename), data);

    const { AuditLifecycle } = await import("../lib/audit-lifecycle.js");
    const lc = new AuditLifecycle();
    lc.configure({ deleteAfterDays: 365 });
    const result = await lc.purgeExpired();

    assert.strictEqual(result.purged, 1);
    assert.ok(!existsSync(join(ARCHIVE_DIR, filename)));
    assert.ok(existsSync(join(ARCHIVE_DIR, recentFilename)));
  });
});

describe("queryAudit", () => {
  beforeEach(() => {
    cleanUp();
    clearS3Env();
  });

  afterEach(() => {
    cleanUp();
    restoreEnv();
  });

  it("returns all entries with no filters", async () => {
    const entries = makeEntries([
      { daysAgo: 5, action: "build" },
      { daysAgo: 3, action: "deploy" },
      { daysAgo: 1, action: "test" },
    ]);
    writeAuditLog(entries);

    const { queryAudit } = await import("../lib/audit-query.js");
    const result = await queryAudit({});
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.entries.length, 3);
    // Newest first
    assert.strictEqual(result.entries[0].action, "test");
  });

  it("filters by action", async () => {
    const entries = makeEntries([
      { action: "build" },
      { action: "deploy" },
      { action: "build" },
    ]);
    writeAuditLog(entries);

    const { queryAudit } = await import("../lib/audit-query.js");
    const result = await queryAudit({ action: "build" });
    assert.strictEqual(result.total, 2);
    for (const e of result.entries) {
      assert.strictEqual(e.action, "build");
    }
  });

  it("filters by userId", async () => {
    const entries = makeEntries([
      { userId: "alice" },
      { userId: "bob" },
      { userId: "alice" },
    ]);
    writeAuditLog(entries);

    const { queryAudit } = await import("../lib/audit-query.js");
    const result = await queryAudit({ userId: "alice" });
    assert.strictEqual(result.total, 2);
  });

  it("filters by dateRange", async () => {
    const entries = makeEntries([
      { daysAgo: 10 },
      { daysAgo: 5 },
      { daysAgo: 1 },
    ]);
    writeAuditLog(entries);

    const { queryAudit } = await import("../lib/audit-query.js");
    const result = await queryAudit({
      dateRange: { start: daysAgo(7), end: daysAgo(0) },
    });
    assert.strictEqual(result.total, 2);
  });

  it("supports pagination with cursor and limit", async () => {
    const entries = makeEntries(
      Array.from({ length: 10 }, (_, i) => ({ daysAgo: i, action: `action-${i}` }))
    );
    writeAuditLog(entries);

    const { queryAudit } = await import("../lib/audit-query.js");
    const page1 = await queryAudit({ limit: 3, cursor: 0 });
    assert.strictEqual(page1.entries.length, 3);
    assert.strictEqual(page1.total, 10);
    assert.strictEqual(page1.cursor, 3);

    const page2 = await queryAudit({ limit: 3, cursor: 3 });
    assert.strictEqual(page2.entries.length, 3);
    assert.strictEqual(page2.cursor, 6);
  });

  it("includes local archive entries in query", async () => {
    // Active entries
    const active = makeEntries([{ daysAgo: 1, action: "recent" }]);
    writeAuditLog(active);

    // Archived entries
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archived = makeEntries([{ daysAgo: 60, action: "old-archived" }]);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(
      join(ARCHIVE_DIR, `audit-${ts}.json.gz`),
      gzipSync(Buffer.from(JSON.stringify(archived), "utf8"))
    );

    const { queryAudit } = await import("../lib/audit-query.js");
    const result = await queryAudit({});
    assert.strictEqual(result.total, 2);
    // newest first
    assert.strictEqual(result.entries[0].action, "recent");
    assert.strictEqual(result.entries[1].action, "old-archived");
  });
});

describe("exportAudit", () => {
  beforeEach(() => {
    cleanUp();
    clearS3Env();
  });

  afterEach(() => {
    cleanUp();
    restoreEnv();
  });

  it("exports as JSON", async () => {
    const entries = makeEntries([{ action: "build", daysAgo: 1 }]);
    writeAuditLog(entries);

    const { exportAudit } = await import("../lib/audit-query.js");
    const result = await exportAudit({}, "json");
    assert.strictEqual(result.contentType, "application/json");
    assert.ok(result.filename.endsWith(".json"));
    const parsed = JSON.parse(result.data);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].action, "build");
  });

  it("exports as CSV with proper headers", async () => {
    const entries = makeEntries([
      { action: "build", ok: true, userId: "alice", daysAgo: 2 },
      { action: "deploy", ok: false, error: "failed", userId: "bob", daysAgo: 1 },
    ]);
    writeAuditLog(entries);

    const { exportAudit } = await import("../lib/audit-query.js");
    const result = await exportAudit({}, "csv");
    assert.strictEqual(result.contentType, "text/csv");
    assert.ok(result.filename.endsWith(".csv"));
    const lines = result.data.split("\n");
    assert.strictEqual(lines[0], "timestamp,action,ok,error,userId,workspaceId,level,source,recipeId,recipeName");
    assert.strictEqual(lines.length, 3); // header + 2 rows
    // Newest first: deploy (1 day ago) before build (2 days ago)
    assert.ok(lines[1].includes("deploy"));
    assert.ok(lines[2].includes("build"));
  });

  it("escapes CSV values containing commas", async () => {
    const entries = makeEntries([
      { action: "build", error: "error, with comma" },
    ]);
    writeAuditLog(entries);

    const { exportAudit } = await import("../lib/audit-query.js");
    const result = await exportAudit({}, "csv");
    const lines = result.data.split("\n");
    // The error field should be quoted
    assert.ok(lines[1].includes('"error, with comma"'));
  });
});
