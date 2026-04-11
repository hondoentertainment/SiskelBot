/**
 * Phase 48.1: Wallet authentication routes.
 *
 *   POST   /api/v1/auth/wallet/challenge         — body: { address, chain }
 *   POST   /api/v1/auth/wallet/verify            — body: { address, chain, message, signature }
 *   POST   /api/v1/auth/wallet/link              — authenticated; body: { address, chain, message, signature }
 *   DELETE /api/v1/auth/wallet/:address          — authenticated; unlink
 *   GET    /api/v1/auth/wallet/list              — authenticated; list linked wallets
 */
import {
  SUPPORTED_CHAINS,
  createChallenge,
  verifyChallenge,
  linkWalletToUser,
  unlinkWallet,
  getWalletsForUser,
  getUserByWallet,
} from "../lib/wallet-auth.js";

function resolveUri(req) {
  if (process.env.WALLET_AUTH_URI) return process.env.WALLET_AUTH_URI;
  const proto = req.protocol || "http";
  const host = req.headers?.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

function resolveDomain(req) {
  if (process.env.WALLET_AUTH_DOMAIN) return process.env.WALLET_AUTH_DOMAIN;
  const host = req.headers?.host;
  if (!host) return null;
  return String(host).split(":")[0];
}

export function mountWalletAuthRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, userAuth } = deps;
  const limiter = typeof storageRateLimiter === "function" ? storageRateLimiter : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : (_req, _res, next) => next();

  // POST /auth/wallet/challenge
  apiRoute("post", "/auth/wallet/challenge", limiter, async (req, res) => {
    try {
      const { address, chain } = req.body || {};
      if (!address) return apiError(res, 400, "INVALID_INPUT", "address is required");
      if (!chain) return apiError(res, 400, "INVALID_INPUT", "chain is required");
      if (!Object.prototype.hasOwnProperty.call(SUPPORTED_CHAINS, chain)) {
        return apiError(res, 400, "UNSUPPORTED_CHAIN", `chain must be one of: ${Object.keys(SUPPORTED_CHAINS).join(", ")}`);
      }
      const result = await createChallenge(address, chain, {
        domain: resolveDomain(req) || undefined,
        uri: resolveUri(req) || undefined,
      });
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "failed to create challenge");
    }
  });

  // POST /auth/wallet/verify
  apiRoute("post", "/auth/wallet/verify", limiter, async (req, res) => {
    try {
      const { address, chain, message, signature } = req.body || {};
      if (!address) return apiError(res, 400, "INVALID_INPUT", "address is required");
      if (!chain) return apiError(res, 400, "INVALID_INPUT", "chain is required");
      if (!message) return apiError(res, 400, "INVALID_INPUT", "message is required");
      if (!signature) return apiError(res, 400, "INVALID_INPUT", "signature is required");
      const result = await verifyChallenge(address, chain, signature, message);
      if (!result.verified) {
        return apiError(res, 401, "VERIFICATION_FAILED", result.error || "signature verification failed");
      }
      return res.json({
        _version: 1,
        verified: true,
        userId: result.userId || null,
        address,
        chain,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "verify failed");
    }
  });

  // POST /auth/wallet/link — authenticated: proves wallet ownership and binds to req.userId
  apiRoute("post", "/auth/wallet/link", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId;
      if (!userId || userId === "anonymous") {
        return apiError(res, 401, "AUTH_REQUIRED", "user must be authenticated to link a wallet");
      }
      const { address, chain, message, signature } = req.body || {};
      if (!address) return apiError(res, 400, "INVALID_INPUT", "address is required");
      if (!chain) return apiError(res, 400, "INVALID_INPUT", "chain is required");
      if (!message) return apiError(res, 400, "INVALID_INPUT", "message is required");
      if (!signature) return apiError(res, 400, "INVALID_INPUT", "signature is required");

      const verification = await verifyChallenge(address, chain, signature, message);
      if (!verification.verified) {
        return apiError(res, 401, "VERIFICATION_FAILED", verification.error || "signature verification failed");
      }
      if (verification.userId && verification.userId !== userId) {
        return apiError(res, 409, "WALLET_TAKEN", "wallet is linked to another user");
      }
      const existingOwner = await getUserByWallet(address, chain);
      if (existingOwner && existingOwner !== userId) {
        return apiError(res, 409, "WALLET_TAKEN", "wallet is linked to another user");
      }
      const record = await linkWalletToUser(userId, address, chain);
      return res.status(201).json({ _version: 1, linked: true, wallet: record });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "link failed");
    }
  });

  // DELETE /auth/wallet/:address — authenticated unlink
  apiRoute("delete", "/auth/wallet/:address", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId;
      if (!userId || userId === "anonymous") {
        return apiError(res, 401, "AUTH_REQUIRED", "user must be authenticated to unlink a wallet");
      }
      const { address } = req.params;
      const removed = await unlinkWallet(userId, address);
      if (!removed) {
        return apiError(res, 404, "NOT_FOUND", "wallet not linked to this user");
      }
      return res.json({ _version: 1, unlinked: true, address });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "unlink failed");
    }
  });

  // GET /auth/wallet/list — authenticated list of a user's wallets
  apiRoute("get", "/auth/wallet/list", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || req.query?.userId;
      if (!userId || userId === "anonymous") {
        return apiError(res, 401, "AUTH_REQUIRED", "user must be authenticated to list wallets");
      }
      const wallets = await getWalletsForUser(userId);
      return res.json({ _version: 1, wallets, count: wallets.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });
}

export default mountWalletAuthRoutes;
