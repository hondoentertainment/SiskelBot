import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("browser file tools stay off until the flag and workspace policy are both on", async () => {
  const prevFlag = process.env.BROWSER_FILE_TRANSFER;
  const prevStore = process.env.STORAGE_PATH;
  const prevUpload = process.env.BROWSER_UPLOAD_ROOT;
  const prevAllow = process.env.BROWSER_URL_ALLOWLIST;
  const dir = mkdtempSync(join(tmpdir(), "bfile-"));
  process.env.STORAGE_PATH = dir;
  delete process.env.BROWSER_FILE_TRANSFER;
  const { runTool, getToolsSchema } = await import("../lib/agent-tools.js");
  const { saveWorkspaceAgentSettings } = await import("../lib/workspace-agent-settings.js");
  try {
    const hidden = getToolsSchema().map((tool) => tool.function.name);
    assert.equal(hidden.includes("browser_download_file"), false);

    const disabled = JSON.parse((await runTool("browser_download_file", { url: "https://files.example.com/a.txt" }, {
      workspace: "default",
      workspaceUserId: "ada",
    })).content);
    assert.equal(disabled.code, "BROWSER_FILE_TRANSFER_DISABLED");

    process.env.BROWSER_FILE_TRANSFER = "1";
    const policyOff = JSON.parse((await runTool("browser_download_file", { url: "https://files.example.com/a.txt" }, {
      workspace: "default",
      workspaceUserId: "ada",
    })).content);
    assert.equal(policyOff.code, "BROWSER_FILE_POLICY_DISABLED");

    await saveWorkspaceAgentSettings("ada", "default", {
      agentPolicy: {
        browserFileTransferEnabled: true,
        browserAllowedHosts: ["files.example.com"],
      },
    });
    const original = globalThis.fetch;
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        arrayBuffer: async () => Buffer.from("report"),
      };
    };
    try {
      const downloaded = JSON.parse((await runTool("browser_download_file", {
        url: "https://files.example.com/report.txt",
      }, { workspace: "default", workspaceUserId: "ada" })).content);
      assert.equal(downloaded.ok, true);
      assert.equal(downloaded.bytes, 6);
      assert.equal(seen, "https://files.example.com/report.txt");
      const blocked = JSON.parse((await runTool("browser_download_file", {
        url: "https://evil.example/secret",
      }, { workspace: "default", workspaceUserId: "ada" })).content);
      assert.match(String(blocked.error || blocked.code), /not allowed|HITL_REQUIRED|ALLOWLIST/);
    } finally {
      globalThis.fetch = original;
    }

    const file = join(dir, "note.txt");
    writeFileSync(file, "hello");
    process.env.BROWSER_UPLOAD_ROOT = dir;
    const uploaded = JSON.parse((await runTool("browser_upload_file", {
      selector: "input[type=file]",
      filepath: file,
    }, { workspace: "default", workspaceUserId: "ada" })).content);
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.bytes, 5);
    const escaped = JSON.parse((await runTool("browser_upload_file", {
      selector: "input[type=file]",
      filepath: join(dir, "..", "note.txt"),
    }, { workspace: "default", workspaceUserId: "ada" })).content);
    assert.equal(escaped.code, "PATH_NOT_ALLOWED");
  } finally {
    if (prevFlag === undefined) delete process.env.BROWSER_FILE_TRANSFER;
    else process.env.BROWSER_FILE_TRANSFER = prevFlag;
    if (prevStore === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStore;
    if (prevUpload === undefined) delete process.env.BROWSER_UPLOAD_ROOT;
    else process.env.BROWSER_UPLOAD_ROOT = prevUpload;
    if (prevAllow === undefined) delete process.env.BROWSER_URL_ALLOWLIST;
    else process.env.BROWSER_URL_ALLOWLIST = prevAllow;
    rmSync(dir, { recursive: true, force: true });
  }
});
