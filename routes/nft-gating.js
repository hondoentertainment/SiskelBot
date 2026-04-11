/**
 * Phase 48.2: NFT-gated workspaces routes.
 *
 * POST   /api/v1/workspaces/:id/nft-gate    — admin, set/replace a workspace gate
 * GET    /api/v1/workspaces/:id/nft-gate    — admin, get the current gate
 * DELETE /api/v1/workspaces/:id/nft-gate    — admin, remove the gate
 * POST   /api/v1/nft/claim                  — authenticated, claim local NFT ownership
 * POST   /api/v1/nft/verify-access          — verify wallet access to a workspace
 * GET    /api/v1/nft/gated-workspaces       — list gated workspaces (optional chain filter)
 */
import {
  setNftGate,
  getNftGate,
  removeNftGate,
  claimNftOwnership,
  verifyWorkspaceAccess,
  listGatedWorkspaces,
} from "../lib/nft-gating.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|invalid|is not/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code =
    status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "nft-gating error");
}

export function mountNftGatingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/workspaces/:id/nft-gate
  apiRoute(
    "post",
    "/workspaces/:id/nft-gate",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!body.chain) return apiError(res, 400, "INVALID_INPUT", "chain is required");
        if (!body.contract) return apiError(res, 400, "INVALID_INPUT", "contract is required");
        const gate = await setNftGate(req.params.id, {
          chain: body.chain,
          contract: body.contract,
          tokenIds: body.tokenIds,
          minBalance: body.minBalance,
          collection: body.collection,
        });
        return res.status(201).json({ _version: 1, gate });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/workspaces/:id/nft-gate
  apiRoute("get", "/workspaces/:id/nft-gate", log, auth, scope("read"), async (req, res) => {
    try {
      const gate = await getNftGate(req.params.id);
      if (!gate) {
        return apiError(res, 404, "NOT_FOUND", `no gate configured for workspace ${req.params.id}`);
      }
      return res.json({ _version: 1, gate });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/workspaces/:id/nft-gate
  apiRoute(
    "delete",
    "/workspaces/:id/nft-gate",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const removed = await removeNftGate(req.params.id);
        if (!removed) {
          return apiError(res, 404, "NOT_FOUND", `no gate configured for workspace ${req.params.id}`);
        }
        return res.json({ _version: 1, removed: true });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/nft/claim
  apiRoute("post", "/nft/claim", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.walletAddress) {
        return apiError(res, 400, "INVALID_INPUT", "walletAddress is required");
      }
      if (!body.contract) {
        return apiError(res, 400, "INVALID_INPUT", "contract is required");
      }
      if (body.tokenId === undefined || body.tokenId === null) {
        return apiError(res, 400, "INVALID_INPUT", "tokenId is required");
      }
      if (!body.chain) {
        return apiError(res, 400, "INVALID_INPUT", "chain is required");
      }
      const claim = await claimNftOwnership(
        body.walletAddress,
        body.contract,
        body.tokenId,
        body.chain,
      );
      return res.status(201).json({ _version: 1, claim });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/nft/verify-access
  apiRoute("post", "/nft/verify-access", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      }
      const result = await verifyWorkspaceAccess(body.walletAddress || "", body.workspaceId);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/nft/gated-workspaces
  apiRoute("get", "/nft/gated-workspaces", log, auth, scope("read"), async (req, res) => {
    try {
      const chain = req.query?.chain ? String(req.query.chain) : null;
      const workspaces = await listGatedWorkspaces(chain);
      return res.json({ _version: 1, workspaces, count: workspaces.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountNftGatingRoutes;
