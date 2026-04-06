import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import {
  workspaceWriteFile,
  workspaceGitStatus,
  commandRunnerAllowed,
  workspaceRunCommand,
  workspaceGitCommit,
} from "../lib/workspace-act-tools.js";

const ctx = (root) => ({ workspaceFilesystemRoot: root, workspace: "default" });

test("workspaceWriteFile requires flag", async () => {
  const prev = process.env.WORKSPACE_FILE_WRITE_TOOLS;
  delete process.env.WORKSPACE_FILE_WRITE_TOOLS;
  const root = mkdtempSync(join(tmpdir(), "w4-"));
  const r = await workspaceWriteFile(ctx(root), { path: "a.txt", content: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "WRITE_DISABLED");
  process.env.WORKSPACE_FILE_WRITE_TOOLS = prev;
});

test("workspaceWriteFile creates and backs up", async () => {
  const prev = process.env.WORKSPACE_FILE_WRITE_TOOLS;
  process.env.WORKSPACE_FILE_WRITE_TOOLS = "1";
  try {
    const root = mkdtempSync(join(tmpdir(), "w4-"));
    const r1 = await workspaceWriteFile(ctx(root), { path: "a.txt", content: "one" });
    assert.equal(r1.ok, true);
    const r2 = await workspaceWriteFile(ctx(root), { path: "a.txt", content: "two" });
    assert.equal(r2.ok, true);
    const bak = existsSync(join(root, "a.txt"));
    assert.ok(bak);
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_FILE_WRITE_TOOLS;
    else process.env.WORKSPACE_FILE_WRITE_TOOLS = prev;
  }
});

test("commandRunnerAllowed rejects non-allowlisted exe", () => {
  const prev = process.env.WORKSPACE_COMMAND_ALLOWLIST;
  process.env.WORKSPACE_COMMAND_ALLOWLIST = "npm,git";
  try {
    const b = commandRunnerAllowed(["rm", "-rf", "/"]);
    assert.equal(b.ok, false);
    const ok = commandRunnerAllowed(["git", "--version"]);
    assert.equal(ok.ok, true);
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_COMMAND_ALLOWLIST;
    else process.env.WORKSPACE_COMMAND_ALLOWLIST = prev;
  }
});

test("workspaceRunCommand runs allowlisted git init", async () => {
  const prevA = process.env.WORKSPACE_COMMAND_ALLOWLIST;
  const root = mkdtempSync(join(tmpdir(), "w4-"));
  process.env.WORKSPACE_COMMAND_ALLOWLIST = "git";
  try {
    const r = await workspaceRunCommand(ctx(root), ["git", "init"]);
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(root, ".git")));
  } finally {
    if (prevA === undefined) delete process.env.WORKSPACE_COMMAND_ALLOWLIST;
    else process.env.WORKSPACE_COMMAND_ALLOWLIST = prevA;
  }
});

test("workspaceGitStatus needs WORKSPACE_GIT_TOOLS", async () => {
  const prev = process.env.WORKSPACE_GIT_TOOLS;
  delete process.env.WORKSPACE_GIT_TOOLS;
  const root = mkdtempSync(join(tmpdir(), "w4-"));
  const r = await workspaceGitStatus(ctx(root));
  assert.equal(r.code, "GIT_READ_DISABLED");
  process.env.WORKSPACE_GIT_TOOLS = prev;
});

test("workspaceGitCommit requires flag", async () => {
  const prevW = process.env.WORKSPACE_GIT_WRITE;
  delete process.env.WORKSPACE_GIT_WRITE;
  const root = mkdtempSync(join(tmpdir(), "w4-"));
  const r = await workspaceGitCommit(ctx(root), { message: "m", paths: ["f.txt"] });
  assert.equal(r.code, "GIT_WRITE_DISABLED");
  process.env.WORKSPACE_GIT_WRITE = prevW;
});
