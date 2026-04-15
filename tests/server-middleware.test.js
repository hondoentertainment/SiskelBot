/**
 * Smoke test for lib/server-middleware.js — verifies the exported
 * installer is callable and wires middleware onto an Express app without
 * throwing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { installServerMiddleware } from "../lib/server-middleware.js";

test("installServerMiddleware is an async function", () => {
  assert.equal(typeof installServerMiddleware, "function");
});

test("installServerMiddleware returns oauth/sso provider descriptors", async () => {
  const app = express();
  const result = await installServerMiddleware(app, { IS_PRODUCTION: false });
  assert.ok(result && typeof result === "object", "expected result object");
  assert.ok(
    "oauthProviders" in result,
    "expected oauthProviders in return value",
  );
  assert.ok(
    "ssoProviders" in result,
    "expected ssoProviders in return value",
  );
});
