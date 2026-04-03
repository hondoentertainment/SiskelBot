// Federation routes extracted from server.js
import express from "express";

export function mountFederationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    requireScope,
    logRequest,
    storageRateLimiter,
    registerPeer,
    removePeer,
    listPeers,
    discoverFederatedWorkspaces,
    syncWorkspaceMetadata,
    handleDiscoverRequest,
    getInstanceInfo,
    federationAuth,
  } = deps;

  apiRoute("get", "/federation/peers", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const peers = await listPeers();
      res.json({ ok: true, peers });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/federation/peers", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { url, sharedSecret } = req.body || {};
      if (!url) return apiError(res, 400, "BAD_REQUEST", "Peer URL is required");
      const peer = await registerPeer(url, sharedSecret);
      res.status(201).json({ ok: true, peer });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("delete", "/federation/peers/:id", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const removed = await removePeer(req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Peer not found");
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/federation/discover", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const query = req.query.q || req.query.query || null;
      const workspaces = await discoverFederatedWorkspaces(query);
      res.json({ ok: true, workspaces });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/federation/sync", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { workspaceId, name, description, discoverable } = req.body || {};
      if (!workspaceId) return apiError(res, 400, "BAD_REQUEST", "workspaceId is required");
      const result = await syncWorkspaceMetadata(workspaceId, { name, description, discoverable });
      res.json({ ok: true, workspace: result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Internal federation endpoints
  app.post("/api/internal/federation/ping", express.json(), federationAuth, (req, res) => {
    const info = getInstanceInfo();
    res.json({ ok: true, ...info });
  });

  app.post("/api/internal/federation/discover", express.json(), federationAuth, async (req, res) => {
    try {
      const query = req.body?.query || null;
      const workspaces = await handleDiscoverRequest(query);
      res.json({ ok: true, workspaces });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
