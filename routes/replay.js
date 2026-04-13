/**
 * Replay & Share: mint tokens that grant read-only public access to the
 * recorded trajectory of an agent run / session, and serve a minimal HTML
 * replay viewer plus a JSON events endpoint scoped by the token.
 */
import { getAgentSession } from "../lib/agent-session.js";
import { loadTrajectory } from "../lib/agent-trajectory.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";
import {
  mintReplayToken,
  verifyReplayToken,
  revokeReplayToken,
} from "../lib/replay-tokens.js";

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TTL_MS = 30 * 24 * 3600 * 1000;
const MIN_TTL_MS = 60 * 1000;

function resolveRunIdForSession(session) {
  if (!session) return null;
  if (Array.isArray(session.runIds) && session.runIds.length > 0) {
    return String(session.runIds[0]);
  }
  return String(session.id);
}

function publicEventsFromTrajectory(trajectory) {
  if (!trajectory || typeof trajectory !== "object") return [];
  if (Array.isArray(trajectory.steps)) {
    return trajectory.steps.map((step, idx) => ({
      index: idx,
      type: typeof step?.type === "string" ? step.type : "event",
      name: typeof step?.name === "string" ? step.name : null,
      at: typeof step?.at === "string" ? step.at : null,
      summary: typeof step?.summary === "string" ? step.summary : null,
      preview: typeof step?.argsPreview === "string" ? step.argsPreview : null,
      result: typeof step?.resultPreview === "string" ? step.resultPreview : null,
    }));
  }
  return [];
}

function publicPlanFromSession(session) {
  if (!session || typeof session !== "object") return null;
  return {
    title: typeof session.title === "string" ? session.title : "",
    planSummary: typeof session.planSummary === "string" ? session.planSummary : "",
    planDag: session.planDag && typeof session.planDag === "object" ? session.planDag : null,
    status: typeof session.status === "string" ? session.status : "",
    planUpdatedAt: typeof session.planUpdatedAt === "string" ? session.planUpdatedAt : null,
  };
}

function renderReplayHtml(token) {
  const safe = String(token).replace(/[^A-Za-z0-9_.-]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <meta name="referrer" content="no-referrer" />
  <title>Replay · SiskelBot</title>
  <link rel="stylesheet" href="/src/views/replay.css" />
</head>
<body>
  <div id="replay-root" data-token="${safe}"></div>
  <script type="module">
    import { mount } from "/src/views/replay.js";
    const el = document.getElementById("replay-root");
    mount(el, { token: el.dataset.token });
  </script>
</body>
</html>
`;
}

/**
 * @param {import("express").Express} app
 * @param {object} deps
 */
export function mountReplayRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  // POST /agent/sessions/:id/share — authenticated mint.
  apiRoute(
    "post",
    "/agent/sessions/:id/share",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      const sessionId = String(req.params.id || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID_ID", "session id required", "Pass :id in the URL.");
      }
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Verify the session id.");
      }
      try {
        const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Workspace access denied", "Join the workspace.");
        }
        const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
        if (session.ownerStorageUserId !== storageUserId) {
          return apiError(res, 403, "FORBIDDEN", "Not the session owner", "Only the owner can share a run.");
        }
        let ttlMs = Number(req.body?.ttlMs);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = DEFAULT_TTL_MS;
        ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs));

        const runId = resolveRunIdForSession(session);
        let token;
        try {
          token = mintReplayToken({
            runId,
            sessionId: session.id,
            workspaceId: session.workspace,
            userId: storageUserId,
            ttlMs,
          });
        } catch (err) {
          if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") {
            return apiError(
              res,
              500,
              "REPLAY_SECRET_MISSING",
              err.message || "Replay secret not configured",
              "Set REPLAY_TOKEN_SECRET or SESSION_SECRET.",
            );
          }
          throw err;
        }
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        return res.status(201).json({
          token,
          url: `/r/${token}`,
          expiresAt,
          runId,
          sessionId: session.id,
        });
      } catch (err) {
        return apiError(
          res,
          500,
          "INTERNAL_ERROR",
          err?.message || "Share mint failed",
          "See server logs.",
        );
      }
    },
  );

  // DELETE /agent/sessions/:id/share/:token — authenticated revoke.
  apiRoute(
    "delete",
    "/agent/sessions/:id/share/:token",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      const sessionId = String(req.params.id || "").trim();
      const token = String(req.params.token || "").trim();
      if (!sessionId || !token) {
        return apiError(res, 400, "INVALID_REQUEST", "session id and token required", "");
      }
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "");
      }
      try {
        const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Workspace access denied", "");
        }
        const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
        if (session.ownerStorageUserId !== storageUserId) {
          return apiError(res, 403, "FORBIDDEN", "Not the session owner", "");
        }
        let result;
        try {
          result = await revokeReplayToken(token);
        } catch (err) {
          if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") {
            return apiError(
              res,
              500,
              "REPLAY_SECRET_MISSING",
              err.message || "Replay secret not configured",
              "Set REPLAY_TOKEN_SECRET or SESSION_SECRET.",
            );
          }
          throw err;
        }
        if (!result.ok) {
          return apiError(res, 400, "INVALID_TOKEN", result.reason || "Cannot revoke token", "");
        }
        return res.json({ ok: true, jti: result.jti });
      } catch (err) {
        return apiError(
          res,
          500,
          "INTERNAL_ERROR",
          err?.message || "Revoke failed",
          "See server logs.",
        );
      }
    },
  );

  // GET /r/:token — PUBLIC minimal replay HTML page.
  app.get("/r/:token", (req, res) => {
    const token = String(req.params.token || "").trim();
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!token) {
      return res.status(400).send("<!doctype html><meta charset=utf-8><title>Replay</title><p>Missing token.</p>");
    }
    verifyReplayToken(token).then((verdict) => {
      if (!verdict.valid) {
        const reason = (verdict.reason || "INVALID").toUpperCase();
        const status = reason === "EXPIRED" || reason === "REVOKED" ? 403 : 403;
        return res
          .status(status)
          .send(
            `<!doctype html><meta charset=utf-8><title>Replay unavailable</title>` +
              `<p>This replay link is no longer available (${reason}).</p>`,
          );
      }
      return res.status(200).send(renderReplayHtml(token));
    }).catch((err) => {
      if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") {
        return res.status(500).send(
          `<!doctype html><meta charset=utf-8><title>Replay misconfigured</title>` +
            `<p>Replay signing secret is not configured.</p>`,
        );
      }
      return res.status(500).send(
        `<!doctype html><meta charset=utf-8><title>Replay error</title><p>Failed to load replay.</p>`,
      );
    });
  });

  // GET /api/v1/replay/:token/events — PUBLIC JSON events endpoint.
  const eventsHandler = async (req, res) => {
    const token = String(req.params.token || "").trim();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (!token) {
      return apiError(res, 400, "INVALID_TOKEN", "token required", "Include a token in the path.");
    }
    let verdict;
    try {
      verdict = await verifyReplayToken(token);
    } catch (err) {
      if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") {
        return apiError(
          res,
          500,
          "REPLAY_SECRET_MISSING",
          err.message || "Replay secret not configured",
          "Set REPLAY_TOKEN_SECRET or SESSION_SECRET.",
        );
      }
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "Verification failed",
        "See server logs.",
      );
    }
    if (!verdict.valid) {
      const reason = verdict.reason || "INVALID";
      const status = reason === "EXPIRED" || reason === "REVOKED" ? 403 : 403;
      return apiError(res, status, reason, "Replay token is not valid.", "Ask the owner for a fresh link.");
    }
    const { claims } = verdict;
    const trajectory = await loadTrajectory(claims.runId);
    const sessionLookupId = claims.sessionId || claims.runId;
    const session = await getAgentSession(sessionLookupId);
    const events = publicEventsFromTrajectory(trajectory);
    return res.json({
      runId: claims.runId,
      workspaceId: claims.workspaceId,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      plan: publicPlanFromSession(session),
      events,
      eventCount: events.length,
      generatedAt: new Date().toISOString(),
    });
  };
  app.get("/api/v1/replay/:token/events", eventsHandler);
  app.get("/api/replay/:token/events", (req, res, next) => {
    res.setHeader("X-API-Deprecated", "use /api/v1/");
    next();
  }, eventsHandler);
}

export default mountReplayRoutes;
