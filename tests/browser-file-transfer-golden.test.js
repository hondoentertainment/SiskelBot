/**
 * Golden eval for browser file transfer on an allowlisted host.
 * Downloads and uploads stay off until BROWSER_FILE_TRANSFER=1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, uploadFile } from "../lib/browser-agent.js";

const page = {
  async setInputFiles() {},
};

test("golden: allowlisted download finishes and a new host waits for approval", async () => {
  const prev = process.env.BROWSER_FILE_TRANSFER;
  const prevHitl = process.env.AGENT_BROWSER_HITL_NEW_DOMAINS;
  process.env.BROWSER_FILE_TRANSFER = "1";
  process.env.AGENT_BROWSER_HITL_NEW_DOMAINS = "1";
  try {
    const fetched = [];
    const ok = await downloadFile(page, "https://files.example.com/report.txt", {
      allowlist: ["files.example.com"],
      workspaceHosts: ["files.example.com"],
      fetchImpl: async (url) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          headers: { get: () => "text/plain" },
          arrayBuffer: async () => Buffer.from("quarterly report"),
        };
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.bytes, Buffer.byteLength("quarterly report"));
    assert.deepEqual(fetched, ["https://files.example.com/report.txt"]);

    await assert.rejects(
      () => downloadFile(page, "https://evil.example/secret", { allowlist: ["files.example.com"] }),
      /not allowed/,
    );

    const hitl = await downloadFile(page, "https://cdn.example.com/a.bin", {
      allowlist: ["cdn.example.com", "files.example.com"],
      workspaceHosts: ["files.example.com"],
      fetchImpl: async () => { throw new Error("should not fetch"); },
    });
    assert.equal(hitl.code, "HITL_REQUIRED");

    const approved = await downloadFile(page, "https://cdn.example.com/a.bin", {
      allowlist: ["cdn.example.com"],
      workspaceHosts: ["files.example.com"],
      hitlApproved: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/octet-stream" },
        arrayBuffer: async () => Buffer.from("ok"),
      }),
    });
    assert.equal(approved.ok, true);

    const redirected = await downloadFile(page, "https://files.example.com/go", {
      allowlist: ["files.example.com"],
      workspaceHosts: ["files.example.com"],
      fetchImpl: async () => ({ ok: false, status: 302, headers: { get: () => "" }, arrayBuffer: async () => Buffer.from("") }),
    });
    assert.equal(redirected.code, "REDIRECT_BLOCKED");
  } finally {
    if (prev === undefined) delete process.env.BROWSER_FILE_TRANSFER;
    else process.env.BROWSER_FILE_TRANSFER = prev;
    if (prevHitl === undefined) delete process.env.AGENT_BROWSER_HITL_NEW_DOMAINS;
    else process.env.AGENT_BROWSER_HITL_NEW_DOMAINS = prevHitl;
  }
});

test("golden: upload stays inside the allowlisted root", async () => {
  const prev = process.env.BROWSER_FILE_TRANSFER;
  process.env.BROWSER_FILE_TRANSFER = "1";
  const dir = mkdtempSync(join(tmpdir(), "upload-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, "hello");
  try {
    const missingRoot = await uploadFile(page, "input[type=file]", file);
    assert.equal(missingRoot.code, "UPLOAD_ROOT_REQUIRED");
    const escaped = await uploadFile(page, "input[type=file]", join(dir, "..", "note.txt"), { root: dir });
    assert.equal(escaped.code, "PATH_NOT_ALLOWED");
    let received = "";
    const ok = await uploadFile({
      async setInputFiles(_selector, abs) { received = abs; },
    }, "input[type=file]", file, { root: dir });
    assert.equal(ok.ok, true);
    assert.equal(ok.bytes, 5);
    assert.equal(received, file);
  } finally {
    if (prev === undefined) delete process.env.BROWSER_FILE_TRANSFER;
    else process.env.BROWSER_FILE_TRANSFER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
