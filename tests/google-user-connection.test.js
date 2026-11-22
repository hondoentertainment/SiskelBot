import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  saveUserGoogleConnection,
  resolveGoogleAccessToken,
  googleConnectionStatus,
  createConnectState,
  consumeConnectState,
  completeOauthCallback,
  googleWorkspaceScopes,
  deleteUserGoogleConnection,
} from "../lib/google-user-connection.js";
import { gmailListMessages } from "../lib/google-workspace-tools.js";
import { buildMorningBrief } from "../lib/advice-brief.js";
import { mountGoogleConnectRoutes } from "../routes/google-connect.js";

function uid() {
  return `guser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildApp(userId) {
  const app = express();
  app.use(express.json());
  const apiError = (res, status, code, msg) => res.status(status).json({ error: msg, code });
  const deps = {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError,
    logRequest: (_req, _res, next) => next(),
    userAuth: (req, _res, next) => {
      req.userId = userId;
      next();
    },
  };
  mountGoogleConnectRoutes(app, deps);
  return app;
}

test("user Google token is preferred over the env token", async () => {
  const userId = uid();
  const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
  process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = "env-token-should-not-win";
  try {
    await saveUserGoogleConnection(userId, {
      accessToken: "user-token-wins",
      expiresAt: Date.now() + 3_600_000,
      email: "ada@example.com",
    });
    const resolved = await resolveGoogleAccessToken(userId);
    assert.equal(resolved.source, "user");
    assert.equal(resolved.token, "user-token-wins");
    assert.equal(resolved.email, "ada@example.com");
    const status = await googleConnectionStatus(userId);
    assert.equal(status.connected, true);
    assert.equal(JSON.stringify(status).includes("user-token-wins"), false);
  } finally {
    await deleteUserGoogleConnection(userId);
    if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    else process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  }
});

test("env token is the fallback when the user has no connection", async () => {
  const userId = uid();
  const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
  process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = "env-fallback-token";
  try {
    const resolved = await resolveGoogleAccessToken(userId);
    assert.equal(resolved.source, "env");
    assert.equal(resolved.token, "env-fallback-token");
    const anon = await resolveGoogleAccessToken("anonymous");
    assert.equal(anon.source, "env");
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    else process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  }
});

test("gmail_list_messages sends the user token, not the env token", async () => {
  const userId = uid();
  const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
  process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = "env-token";
  const original = globalThis.fetch;
  let auth = "";
  globalThis.fetch = async (_url, opts) => {
    auth = opts?.headers?.Authorization || "";
    return {
      ok: true,
      text: async () => JSON.stringify({ messages: [] }),
    };
  };
  try {
    await saveUserGoogleConnection(userId, {
      accessToken: "user-bearer",
      expiresAt: Date.now() + 3_600_000,
    });
    const result = await gmailListMessages({ userId, maxResults: 1 });
    assert.equal(result.ok, true);
    assert.equal(auth, "Bearer user-bearer");
  } finally {
    globalThis.fetch = original;
    await deleteUserGoogleConnection(userId);
    if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    else process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  }
});

test("morning brief uses the user token and stays disconnected without one", async () => {
  const userId = uid();
  const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
  delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
  try {
    const off = await buildMorningBrief(userId, "default", {
      calendarListEvents: undefined,
      gmailListMessages: undefined,
    });
    assert.equal(off.sources.googleConnected, false);

    await saveUserGoogleConnection(userId, {
      accessToken: "brief-user-token",
      expiresAt: Date.now() + 3_600_000,
    });
    const on = await buildMorningBrief(userId, "default", {
      calendarListEvents: async () => ({ ok: true, events: [{ summary: "Standup", start: "2026-11-22T15:00:00Z" }] }),
      gmailListMessages: async () => ({ ok: true, messages: [] }),
    });
    // Injected list functions mark the brief connected even before the token check.
    assert.equal(on.sources.googleConnected, true);

    const original = globalThis.fetch;
    let sawUserToken = false;
    globalThis.fetch = async (_url, opts) => {
      if (String(opts?.headers?.Authorization || "").includes("brief-user-token")) sawUserToken = true;
      return { ok: true, text: async () => JSON.stringify({ messages: [], items: [] }) };
    };
    try {
      const live = await buildMorningBrief(userId, `ws-${userId}`, {});
      assert.equal(live.sources.googleConnected, true);
      assert.equal(sawUserToken, true);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await deleteUserGoogleConnection(userId);
    if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    else process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  }
});

test("OAuth callback stores the token and does not reuse state", async () => {
  const userId = uid();
  const prevId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "exchanged-token", expires_in: 3600, refresh_token: "refresh" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ email: "ada@example.com" }),
    };
  };
  try {
    const state = await createConnectState(userId);
    const saved = await completeOauthCallback({ code: "abc", state });
    assert.equal(saved.source, "user");
    assert.equal(saved.email, "ada@example.com");
    assert.equal(JSON.stringify(saved).includes("exchanged-token"), false);
    const resolved = await resolveGoogleAccessToken(userId);
    assert.equal(resolved.token, "exchanged-token");
    const again = await consumeConnectState(state);
    assert.equal(again, null);
  } finally {
    globalThis.fetch = original;
    await deleteUserGoogleConnection(userId);
    if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
  }
});

test("write scopes stay off unless GOOGLE_WORKSPACE_WRITE_SCOPES=1", () => {
  const prev = process.env.GOOGLE_WORKSPACE_WRITE_SCOPES;
  delete process.env.GOOGLE_WORKSPACE_WRITE_SCOPES;
  const readonly = googleWorkspaceScopes();
  assert.equal(readonly.some((s) => s.includes("gmail.send")), false);
  process.env.GOOGLE_WORKSPACE_WRITE_SCOPES = "1";
  const write = googleWorkspaceScopes();
  assert.equal(write.some((s) => s.includes("gmail.send")), true);
  if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_WRITE_SCOPES;
  else process.env.GOOGLE_WORKSPACE_WRITE_SCOPES = prev;
});

test("status and connection routes never return the access token", async () => {
  const userId = uid();
  const app = buildApp(userId);
  const created = await request(app)
    .post("/api/v1/google/workspace/connection")
    .send({ accessToken: "super-secret-token", email: "ada@example.com", expiresAt: Date.now() + 100000 });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes("super-secret-token"), false);
  const status = await request(app).get("/api/v1/google/workspace/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.source, "user");
  assert.equal(JSON.stringify(status.body).includes("super-secret-token"), false);
  const anon = buildApp("anonymous");
  const denied = await request(anon).post("/api/v1/google/workspace/connection").send({ accessToken: "x" });
  assert.equal(denied.status, 401);
  await deleteUserGoogleConnection(userId);
});

test("connect route reports missing OAuth client instead of redirecting", async () => {
  const prevId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    const app = buildApp(uid());
    const res = await request(app).get("/api/v1/google/workspace/connect");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "GOOGLE_OAUTH_NOT_CONFIGURED");
  } finally {
    if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
  }
});
