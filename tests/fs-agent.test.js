import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PathGuard,
  SYSTEM_BLOCKED,
  readFile,
  writeFile,
  appendFile,
  deleteFile,
  renameFile,
  copyFile,
  createDir,
  listDir,
  getStats,
  findFiles,
  searchInFiles,
  previewOperation,
  backupFile,
  restoreBackup,
  atomicWrite,
  createFsSession,
  recordFsOperation,
  getFsHistory,
  undoLastFsOperation,
} from "../lib/fs-agent.js";

function makeRoot(prefix = "fsa-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeStorage() {
  // Each test owns its own STORAGE_PATH so the backup/session json stores
  // don't collide with other tests.
  const dir = mkdtempSync(join(tmpdir(), "fsa-store-"));
  process.env.STORAGE_PATH = dir;
  return dir;
}

test("PathGuard.isAllowed accepts path inside allowed root", () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  assert.equal(g.isAllowed(join(root, "hello.txt")), true);
  assert.equal(g.isAllowed(root), true);
});

test("PathGuard.isAllowed denies paths outside the root", () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  assert.equal(g.isAllowed("/tmp/totally-elsewhere-xyz"), false);
});

test("PathGuard.isAllowed denies traversal segments in raw string", () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  assert.equal(g.isAllowed(`${root}/sub/../../etc/passwd`), false);
});

test("PathGuard rejects SYSTEM_BLOCKED paths even if under allowed root prefix", () => {
  const g = new PathGuard({ allowedRoots: ["/"] });
  assert.equal(g.isAllowed("/etc/passwd"), false);
  assert.equal(g.isAllowed("/proc/self"), false);
  assert.equal(g.isAllowed("/home/user/.ssh/id_rsa"), false);
  assert.equal(g.isAllowed("/opt/app/secret.pem"), false);
  assert.ok(SYSTEM_BLOCKED.length > 0);
});

test("PathGuard.sanitize strips .. segments", () => {
  const g = new PathGuard({ allowedRoots: ["/tmp"] });
  assert.equal(g.sanitize("foo/../bar"), "foo/bar");
  assert.equal(g.sanitize("./foo/./bar"), "foo/bar");
});

test("readFile reads a valid file inside the allowed root", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "a.txt"), "hello", "utf8");
  const g = new PathGuard({ allowedRoots: [root] });
  const content = await readFile(join(root, "a.txt"), { guard: g });
  assert.equal(content, "hello");
});

test("readFile denies /etc/passwd", async () => {
  const g = new PathGuard({ allowedRoots: ["/"] });
  await assert.rejects(() => readFile("/etc/passwd", { guard: g }), /Path not allowed/);
});

test("readFile respects maxBytes", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "big.txt"), "x".repeat(100), "utf8");
  const g = new PathGuard({ allowedRoots: [root] });
  await assert.rejects(
    () => readFile(join(root, "big.txt"), { guard: g, maxBytes: 10 }),
    /exceeds maxBytes/,
  );
});

test("writeFile creates a new file with the given content", async () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  const res = await writeFile(join(root, "new.txt"), "world", { guard: g });
  assert.equal(res.ok, true);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "world");
});

test("writeFile dryRun does not actually write", async () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  const res = await writeFile(join(root, "phantom.txt"), "nope", { guard: g, dryRun: true });
  assert.equal(res.wouldWrite, true);
  assert.equal(res.size, 4);
  assert.equal(existsSync(join(root, "phantom.txt")), false);
});

test("appendFile appends content", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "log.txt"), "line1\n", "utf8");
  const g = new PathGuard({ allowedRoots: [root] });
  await appendFile(join(root, "log.txt"), "line2\n", { guard: g });
  assert.equal(readFileSync(join(root, "log.txt"), "utf8"), "line1\nline2\n");
});

test("deleteFile removes a file", async () => {
  const root = makeRoot();
  const p = join(root, "gone.txt");
  writeFileSync(p, "x");
  const g = new PathGuard({ allowedRoots: [root] });
  await deleteFile(p, { guard: g });
  assert.equal(existsSync(p), false);
});

test("renameFile renames within the allowed root", async () => {
  const root = makeRoot();
  const a = join(root, "a.txt");
  const b = join(root, "b.txt");
  writeFileSync(a, "data");
  const g = new PathGuard({ allowedRoots: [root] });
  await renameFile(a, b, { guard: g });
  assert.equal(existsSync(a), false);
  assert.equal(readFileSync(b, "utf8"), "data");
});

test("copyFile copies within the allowed root", async () => {
  const root = makeRoot();
  const a = join(root, "src.txt");
  const b = join(root, "dst.txt");
  writeFileSync(a, "hi");
  const g = new PathGuard({ allowedRoots: [root] });
  await copyFile(a, b, { guard: g });
  assert.equal(readFileSync(b, "utf8"), "hi");
  assert.equal(readFileSync(a, "utf8"), "hi");
});

test("createDir creates a nested directory", async () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  await createDir(join(root, "a/b/c"), { guard: g });
  assert.equal(statSync(join(root, "a/b/c")).isDirectory(), true);
});

test("listDir returns entries with type", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "f.txt"), "x");
  mkdirSync(join(root, "sub"));
  const g = new PathGuard({ allowedRoots: [root] });
  const r = await listDir(root, { guard: g });
  const names = r.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ["f.txt", "sub"]);
  const sub = r.entries.find((e) => e.name === "sub");
  assert.equal(sub.type, "dir");
});

test("getStats returns file metadata", async () => {
  const root = makeRoot();
  const p = join(root, "s.txt");
  writeFileSync(p, "hello");
  const g = new PathGuard({ allowedRoots: [root] });
  const st = await getStats(p, { guard: g });
  assert.equal(st.isFile, true);
  assert.equal(st.size, 5);
});

test("findFiles matches glob pattern", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "a.js"), "x");
  writeFileSync(join(root, "b.js"), "x");
  writeFileSync(join(root, "c.txt"), "x");
  const g = new PathGuard({ allowedRoots: [root] });
  const res = await findFiles(root, "*.js", { guard: g });
  assert.equal(res.matches.length, 2);
  assert.ok(res.matches.every((m) => m.endsWith(".js")));
});

test("searchInFiles finds substring matches", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "one.txt"), "alpha beta\ngamma delta\n");
  writeFileSync(join(root, "two.txt"), "just words here\n");
  const g = new PathGuard({ allowedRoots: [root] });
  const res = await searchInFiles(root, "beta", { guard: g });
  assert.equal(res.matchCount, 1);
  assert.equal(res.matches[0].line, 1);
});

test("previewOperation shows write without executing", async () => {
  const root = makeRoot();
  const g = new PathGuard({ allowedRoots: [root] });
  const p = join(root, "preview.txt");
  const res = await previewOperation(
    { type: "write", args: { path: p, content: "hey", guard: g } },
  );
  assert.equal(res.ok, true);
  assert.equal(res.preview.wouldWrite, true);
  assert.equal(existsSync(p), false);
});

test("backupFile + restoreBackup round-trip", async () => {
  makeStorage();
  const root = makeRoot();
  process.env.WORKSPACE_ROOT = root;
  const p = join(root, "doc.txt");
  writeFileSync(p, "original");
  const entry = await backupFile(p);
  assert.ok(entry.id);
  // Mutate the file then restore.
  writeFileSync(p, "changed");
  assert.equal(readFileSync(p, "utf8"), "changed");
  await restoreBackup(entry.id);
  assert.equal(readFileSync(p, "utf8"), "original");
  delete process.env.WORKSPACE_ROOT;
});

test("atomicWrite writes via a temp file", async () => {
  const root = makeRoot();
  const p = join(root, "atomic.txt");
  const res = await atomicWrite(p, "durable");
  assert.equal(res.ok, true);
  assert.equal(readFileSync(p, "utf8"), "durable");
  // Temp siblings should have been cleaned up.
  const siblings = await import("node:fs/promises").then((m) => m.readdir(root));
  assert.equal(siblings.filter((n) => n.includes(".tmp")).length, 0);
});

test("createFsSession records history and returns it", async () => {
  makeStorage();
  const s = await createFsSession("alpha");
  await recordFsOperation(s.id, { type: "write", args: { path: "/x" } }, { path: "/x", size: 1 });
  const hist = await getFsHistory(s.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].operation.type, "write");
});

test("undoLastFsOperation pops history and handles write without backup", async () => {
  makeStorage();
  const root = makeRoot();
  process.env.WORKSPACE_ROOT = root;
  const s = await createFsSession("undo-test");
  const g = new PathGuard({ allowedRoots: [root] });
  const p = join(root, "undo.txt");
  const writeRes = await writeFile(p, "created", { guard: g });
  await recordFsOperation(s.id, { type: "write", args: { path: p } }, writeRes);
  assert.equal(existsSync(p), true);
  const undoRes = await undoLastFsOperation(s.id);
  assert.equal(undoRes.ok, true);
  assert.equal(existsSync(p), false);
  const hist = await getFsHistory(s.id);
  assert.equal(hist.length, 0);
  delete process.env.WORKSPACE_ROOT;
});
