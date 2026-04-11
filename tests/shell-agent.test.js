/**
 * Phase 55.3: Sandboxed shell agent tests.
 *
 * All shell execution is mocked via an injectable `exec` function. No real
 * subprocess is ever spawned by these tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-shell-agent-data-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  runShellCommand,
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  isCommandAllowed,
  setDefaultAllowlist,
  getDefaultAllowlist,
} = await import("../lib/shell-agent.js");

// Sandbox root for jailed commands.
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "siskel-shell-agent-root-"));

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  try { rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                  */
/* -------------------------------------------------------------------------- */

test("isCommandAllowed accepts default allowlist entries", () => {
  assert.equal(isCommandAllowed("ls"), true);
  assert.equal(isCommandAllowed("echo hello"), true);
  assert.equal(isCommandAllowed("git status"), true);
});

test("isCommandAllowed rejects unknown commands", () => {
  assert.equal(isCommandAllowed("rm -rf /"), false);
  assert.equal(isCommandAllowed("curl evil.com"), false);
});

test("isCommandAllowed rejects shell metacharacters", () => {
  assert.equal(isCommandAllowed("ls; rm -rf /"), false);
  assert.equal(isCommandAllowed("echo foo | sh"), false);
  assert.equal(isCommandAllowed("ls && rm"), false);
});

test("setDefaultAllowlist replaces the allowlist", () => {
  const original = getDefaultAllowlist();
  setDefaultAllowlist(["pwd"]);
  assert.equal(isCommandAllowed("pwd"), true);
  assert.equal(isCommandAllowed("ls"), false);
  setDefaultAllowlist(original);
});

/* -------------------------------------------------------------------------- */
/* runShellCommand                                                            */
/* -------------------------------------------------------------------------- */

test("runShellCommand invokes the injected exec with a jailed cwd", async () => {
  let seenCmd = "";
  let seenCwd = "";
  const mockExec = (cmd, options, cb) => {
    seenCmd = cmd;
    seenCwd = options.cwd;
    setImmediate(() => cb(null, "ok", ""));
  };
  const r = await runShellCommand("ls -la", {
    root: SANDBOX_ROOT,
    exec: mockExec,
  });
  assert.equal(r.stdout, "ok");
  assert.equal(r.code, 0);
  assert.equal(seenCmd, "ls -la");
  assert.ok(seenCwd.startsWith(SANDBOX_ROOT));
});

test("runShellCommand rejects commands not on allowlist", async () => {
  const mockExec = (_cmd, _opts, cb) => cb(null, "", "");
  await assert.rejects(
    () => runShellCommand("rm -rf /", { root: SANDBOX_ROOT, exec: mockExec }),
    /not in allowlist/,
  );
});

test("runShellCommand rejects cwd escape attempts", async () => {
  const mockExec = (_cmd, _opts, cb) => cb(null, "", "");
  await assert.rejects(
    () => runShellCommand("ls", { root: SANDBOX_ROOT, cwd: "../..", exec: mockExec }),
    /escapes root/,
  );
});

test("runShellCommand captures stderr and non-zero exit code", async () => {
  const mockExec = (_cmd, _opts, cb) => {
    const err = new Error("boom");
    /** @type {any} */ (err).code = 3;
    cb(err, "partial", "oops");
  };
  const r = await runShellCommand("ls", { root: SANDBOX_ROOT, exec: mockExec });
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "oops");
  assert.equal(r.stdout, "partial");
});

test("runShellCommand handles timeout", async () => {
  const slowExec = (_cmd, _opts, _cb) => {
    // never call cb -> force the timer to fire
  };
  const r = await runShellCommand("ls", {
    root: SANDBOX_ROOT,
    exec: slowExec,
    timeoutMs: 50,
  });
  assert.equal(r.timedOut, true);
});

test("runShellCommand validates required inputs", async () => {
  const mockExec = (_cmd, _opts, cb) => cb(null, "", "");
  await assert.rejects(() => runShellCommand("", { root: SANDBOX_ROOT, exec: mockExec }));
  await assert.rejects(() => runShellCommand("ls", { exec: mockExec }));
});

/* -------------------------------------------------------------------------- */
/* Checkpoints                                                                */
/* -------------------------------------------------------------------------- */

function seedSandbox(subdir, files) {
  const dir = join(SANDBOX_ROOT, subdir);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return dir;
}

test("createCheckpoint captures directory contents", async () => {
  const dir = seedSandbox("cp1", { "a.txt": "one", "nested/b.txt": "two" });
  const cp = await createCheckpoint(dir, "initial");
  assert.ok(cp.id);
  assert.ok(cp.fileCount >= 2);
  assert.equal(cp.label, "initial");
});

test("restoreCheckpoint brings files back after destruction", async () => {
  const dir = seedSandbox("cp2", { "keep.txt": "hello", "sub/inner.txt": "world" });
  const cp = await createCheckpoint(dir, "before-destruction");
  // Destroy contents.
  rmSync(join(dir, "keep.txt"));
  rmSync(join(dir, "sub"), { recursive: true, force: true });
  writeFileSync(join(dir, "added.txt"), "new file");

  await restoreCheckpoint(cp.id);
  assert.ok(existsSync(join(dir, "keep.txt")));
  assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "hello");
  assert.ok(existsSync(join(dir, "sub/inner.txt")));
  // Files added after the checkpoint should be gone.
  assert.equal(existsSync(join(dir, "added.txt")), false);
});

test("listCheckpoints returns known checkpoints newest-first", async () => {
  const list = await listCheckpoints();
  assert.ok(list.length >= 2);
  for (const c of list) {
    assert.ok(c.id);
    assert.ok(typeof c.fileCount === "number");
    assert.ok(!("files" in c));
  }
});

test("deleteCheckpoint removes a checkpoint record", async () => {
  const dir = seedSandbox("cp3", { "tmp.txt": "x" });
  const cp = await createCheckpoint(dir, "doomed");
  const ok = await deleteCheckpoint(cp.id);
  assert.equal(ok, true);
  const list = await listCheckpoints();
  assert.ok(!list.some((c) => c.id === cp.id));
});

test("restoreCheckpoint throws on unknown id", async () => {
  await assert.rejects(() => restoreCheckpoint("bogus-id"));
});
