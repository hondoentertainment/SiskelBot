import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpServersEnv, getActiveConnections } from "../lib/mcp-client.js";

test("parseMcpServersEnv parses mixed stdio and http entries", () => {
  const result = parseMcpServersEnv("stdio:/usr/bin/mcp-server,http:https://example.com/mcp");
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "stdio");
  assert.equal(result[0].target, "/usr/bin/mcp-server");
  assert.equal(result[1].type, "http");
  assert.equal(result[1].target, "https://example.com/mcp");
});

test("parseMcpServersEnv returns empty array for undefined input", () => {
  const result = parseMcpServersEnv(undefined);
  assert.deepEqual(result, []);
});

test("parseMcpServersEnv returns empty array for empty string", () => {
  const result = parseMcpServersEnv("");
  assert.deepEqual(result, []);
});

test("parseMcpServersEnv returns empty array for whitespace-only string", () => {
  const result = parseMcpServersEnv("   ");
  assert.deepEqual(result, []);
});

test("parseMcpServersEnv filters out invalid transport types", () => {
  const result = parseMcpServersEnv("ws:ws://example.com,http:https://ok.com");
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "http");
});

test("parseMcpServersEnv filters out entries missing target", () => {
  const result = parseMcpServersEnv("stdio:,http:https://ok.com");
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "http");
});

test("parseMcpServersEnv handles single entry", () => {
  const result = parseMcpServersEnv("stdio:/path/to/server --flag");
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "stdio");
  assert.equal(result[0].target, "/path/to/server --flag");
});

test("getActiveConnections returns empty array initially", () => {
  const connections = getActiveConnections();
  assert.ok(Array.isArray(connections));
  assert.equal(connections.length, 0);
});
