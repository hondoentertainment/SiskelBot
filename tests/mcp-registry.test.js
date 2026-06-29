/**
 * MCP registry tests: durable register/list/unregister and validation.
 * Uses connect:false so no child process or network connection is attempted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-mcpreg-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("register persists a server and lists it (no connect)", async () => {
  const { registerServer, listServers } = await import("../lib/mcp-registry.js");
  const result = await registerServer({ name: "Weather", type: "http", target: "https://example.com/mcp", connect: false });
  assert.equal(result.connected, false);
  assert.equal(result.server.name, "Weather");
  assert.equal(result.server.type, "http");

  const servers = await listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].connected, false);
});

test("register is idempotent on type+target", async () => {
  const { registerServer, listServers } = await import("../lib/mcp-registry.js");
  const before = (await listServers()).length;
  const dup = await registerServer({ type: "http", target: "https://example.com/mcp", connect: false });
  assert.equal(dup.existing, true);
  const after = (await listServers()).length;
  assert.equal(after, before, "no duplicate created");
});

test("register validates type and target", async () => {
  const { registerServer } = await import("../lib/mcp-registry.js");
  await assert.rejects(() => registerServer({ type: "ftp", target: "x", connect: false }));
  await assert.rejects(() => registerServer({ type: "http", target: "", connect: false }));
});

test("getRegistryServerConfigs returns enabled server configs", async () => {
  const { registerServer, getRegistryServerConfigs } = await import("../lib/mcp-registry.js");
  await registerServer({ type: "stdio", target: "/usr/bin/echo hi", connect: false });
  const configs = await getRegistryServerConfigs();
  assert.ok(configs.some((c) => c.type === "stdio" && c.target === "/usr/bin/echo hi"));
  assert.ok(configs.every((c) => c.type && c.target));
});

test("unregister removes a server", async () => {
  const { registerServer, unregisterServer, listServers } = await import("../lib/mcp-registry.js");
  const reg = await registerServer({ type: "http", target: "https://temp.example/mcp", connect: false });
  const removed = await unregisterServer(reg.server.id);
  assert.equal(removed, true);
  const servers = await listServers();
  assert.ok(!servers.some((s) => s.id === reg.server.id));

  const removedAgain = await unregisterServer(reg.server.id);
  assert.equal(removedAgain, false);
});

test("disconnectServer is a no-op when not connected", async () => {
  const { disconnectServer } = await import("../lib/mcp-registry.js");
  assert.equal(disconnectServer("nonexistent-id"), false);
});
