import test from "node:test";
import assert from "node:assert/strict";

// --- registerVoiceCommand / executeVoiceCommand / getCommandHelp ---

test("getCommandHelp returns the default registered commands", async () => {
  const { getCommandHelp, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const commands = getCommandHelp();
  assert.ok(Array.isArray(commands));
  assert.ok(commands.length > 0);
  const actions = commands.map((c) => c.action);
  assert.ok(actions.includes("new_conversation"));
  assert.ok(actions.includes("search"));
  assert.ok(actions.includes("navigate"));
  assert.ok(actions.includes("run_recipe"));
  assert.ok(actions.includes("interrupt"));
});

test("getCommandHelp entries include pattern and description", async () => {
  const { getCommandHelp, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const commands = getCommandHelp();
  for (const c of commands) {
    assert.equal(typeof c.pattern, "string");
    assert.equal(typeof c.action, "string");
    assert.equal(typeof c.description, "string");
  }
});

test("executeVoiceCommand returns executed=false for unknown transcripts", async () => {
  const { executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const result = await executeVoiceCommand("xyz unknown command");
  assert.equal(result.executed, false);
  assert.equal(result.action, null);
  assert.ok(result.response.includes("didn't understand"));
});

test("executeVoiceCommand executes new_conversation default handler", async () => {
  const { executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const result = await executeVoiceCommand("new chat");
  assert.equal(result.executed, true);
  assert.equal(result.action, "new_conversation");
  assert.ok(result.result);
  assert.equal(result.result.ok, true);
});

test("executeVoiceCommand handles search with query param", async () => {
  const { executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const result = await executeVoiceCommand("search for python tutorials");
  assert.equal(result.executed, true);
  assert.equal(result.action, "search");
  assert.equal(result.result.query, "python tutorials");
});

test("executeVoiceCommand handles navigate with destination", async () => {
  const { executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const result = await executeVoiceCommand("show recipes");
  assert.equal(result.executed, true);
  assert.equal(result.action, "navigate");
  assert.equal(result.result.destination, "recipes");
});

test("executeVoiceCommand passes context to handler", async () => {
  const { registerVoiceCommand, executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  let capturedContext = null;
  registerVoiceCommand("ping context", (_params, ctx) => {
    capturedContext = ctx;
    return { ok: true, message: "pong" };
  }, { action: "ping_context", description: "Test context propagation" });

  const result = await executeVoiceCommand("ping context", { userId: "u1", workspaceId: "w1" });
  assert.equal(result.executed, true);
  assert.equal(capturedContext.userId, "u1");
  assert.equal(capturedContext.workspaceId, "w1");
});

test("registerVoiceCommand adds custom pattern and action", async () => {
  const { registerVoiceCommand, executeVoiceCommand, getCommandHelp, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  registerVoiceCommand("brew coffee", () => ({ ok: true, message: "Brewing coffee." }), {
    action: "brew_coffee",
    description: "Brew a cup of coffee",
  });
  const commands = getCommandHelp();
  const found = commands.find((c) => c.action === "brew_coffee");
  assert.ok(found);
  assert.equal(found.pattern, "brew coffee");
  assert.equal(found.description, "Brew a cup of coffee");

  const result = await executeVoiceCommand("brew coffee");
  assert.equal(result.executed, true);
  assert.equal(result.action, "brew_coffee");
  assert.equal(result.result.message, "Brewing coffee.");
});

test("registerVoiceCommand validates inputs", async () => {
  const { registerVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  assert.throws(() => registerVoiceCommand("", () => {}), TypeError);
  assert.throws(() => registerVoiceCommand("valid", null), TypeError);
});

test("unregisterVoiceCommand removes registered patterns", async () => {
  const { registerVoiceCommand, unregisterVoiceCommand, executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  registerVoiceCommand("temporary command", () => ({ ok: true, message: "Temp." }), {
    action: "temp_action",
  });
  let result = await executeVoiceCommand("temporary command");
  assert.equal(result.executed, true);

  const removed = unregisterVoiceCommand("temporary command");
  assert.equal(removed, true);

  result = await executeVoiceCommand("temporary command");
  assert.equal(result.executed, false);
});

test("executeVoiceCommand surfaces handler errors gracefully", async () => {
  const { registerVoiceCommand, executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  registerVoiceCommand("explode now", () => {
    throw new Error("boom");
  }, { action: "explode_now" });
  const result = await executeVoiceCommand("explode now");
  assert.equal(result.executed, false);
  assert.equal(result.action, "explode_now");
  assert.ok(result.response.includes("boom"));
  assert.equal(result.error, "boom");
});

test("executeVoiceCommand recognizes wake-word prefixed transcripts", async () => {
  const { executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const result = await executeVoiceCommand("hey siskelbot new chat");
  assert.equal(result.executed, true);
  assert.equal(result.action, "new_conversation");
});

test("getCommandCount reflects registered commands", async () => {
  const { getCommandCount, registerVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  const before = getCommandCount();
  registerVoiceCommand("counted command", () => ({ ok: true, message: "counted" }), {
    action: "counted_command",
  });
  const after = getCommandCount();
  assert.equal(after, before + 1);
});

test("resetVoiceCommands restores defaults and removes custom commands", async () => {
  const { registerVoiceCommand, executeVoiceCommand, resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();
  registerVoiceCommand("flush this", () => ({ ok: true, message: "flush" }), { action: "flush_this" });
  resetVoiceCommands();
  const result = await executeVoiceCommand("flush this");
  assert.equal(result.executed, false);
  // Defaults should still work after reset.
  const def = await executeVoiceCommand("new chat");
  assert.equal(def.executed, true);
});

// --- HTTP route tests ---

test("voice command routes parse, execute, and list help", async () => {
  process.env.NODE_ENV = "test";
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountVoiceCommandRoutes } = await import("../routes/voice-commands.js");
  const { resetVoiceCommands } = await import("../lib/voice-navigation.js");
  resetVoiceCommands();

  const app = express();
  app.use(express.json());

  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
  };
  const apiError = (res, status, code, message, hint) => {
    res.status(status).json({ error: { code, message, hint: hint || null } });
  };
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();

  mountVoiceCommandRoutes(app, { apiRoute, apiError, logRequest, adminAuth });

  // POST /voice/commands/parse
  let res = await request(app).post("/api/v1/voice/commands/parse").send({ transcript: "search for python" });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, "search");
  assert.equal(res.body.params.query, "python");
  assert.equal(res.body.understood, true);

  // POST /voice/commands/parse — missing transcript
  res = await request(app).post("/api/v1/voice/commands/parse").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "INVALID_BODY");

  // POST /voice/commands/execute
  res = await request(app).post("/api/v1/voice/commands/execute").send({ transcript: "show recipes" });
  assert.equal(res.status, 200);
  assert.equal(res.body.executed, true);
  assert.equal(res.body.action, "navigate");
  assert.equal(res.body.result.destination, "recipes");

  // POST /voice/commands/execute — unknown
  res = await request(app).post("/api/v1/voice/commands/execute").send({ transcript: "do the unknown thing" });
  assert.equal(res.status, 422);
  assert.equal(res.body.executed, false);

  // GET /voice/commands/help
  res = await request(app).get("/api/v1/voice/commands/help");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.commands));
  assert.ok(res.body.count > 0);
  const actions = res.body.commands.map((c) => c.action);
  assert.ok(actions.includes("new_conversation"));

  // POST /voice/commands/register
  res = await request(app).post("/api/v1/voice/commands/register").send({
    pattern: "do the macarena",
    action: "macarena",
    description: "Dance the macarena",
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.registered, true);
  assert.equal(res.body.action, "macarena");

  // The newly registered command should appear in help and execute.
  res = await request(app).get("/api/v1/voice/commands/help");
  const newCmd = res.body.commands.find((c) => c.action === "macarena");
  assert.ok(newCmd);

  res = await request(app).post("/api/v1/voice/commands/execute").send({ transcript: "do the macarena" });
  assert.equal(res.status, 200);
  assert.equal(res.body.executed, true);
  assert.equal(res.body.action, "macarena");

  // POST /voice/commands/register — missing pattern
  res = await request(app).post("/api/v1/voice/commands/register").send({ action: "no_pattern" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "INVALID_BODY");
});
