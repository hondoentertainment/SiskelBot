/**
 * Phase 50.1: Post-quantum CRYSTALS-Kyber (ML-KEM) KEM HTTP endpoints.
 *
 * POST /api/v1/pq/kyber/keypair       — generate a new ML-KEM key pair
 * POST /api/v1/pq/kyber/encapsulate   — encapsulate a shared secret to a pub key
 * POST /api/v1/pq/kyber/decapsulate   — recover the shared secret from a ciphertext
 * GET  /api/v1/pq/kyber/info          — supported levels + implementation metadata
 *
 * All endpoints accept/return base64-encoded binary material. See
 * `lib/pq-kyber.js` for the (currently transitional hybrid stub)
 * implementation.
 */

import {
  KYBER_PARAMS,
  generateKyberKeyPair,
  kyberEncapsulate,
  kyberDecapsulate,
  serializeKyberKey,
  deserializeKyberKey,
  kyberInfo,
} from "../lib/pq-kyber.js";

const SUPPORTED_LEVELS = Object.keys(KYBER_PARAMS);

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/required|must be|invalid|mismatch|truncated|unknown|not valid|length/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "pq-kyber error");
}

function resolveLevel(raw, fallback = "ml-kem-768") {
  if (raw == null) return fallback;
  if (!SUPPORTED_LEVELS.includes(raw)) {
    throw new Error(
      `invalid level ${JSON.stringify(raw)}; supported: ${SUPPORTED_LEVELS.join(", ")}`,
    );
  }
  return raw;
}

export function mountPqKyberRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/pq/kyber/info
  apiRoute("get", "/pq/kyber/info", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, ...kyberInfo(), supportedLevels: SUPPORTED_LEVELS });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/kyber/keypair
  apiRoute("post", "/pq/kyber/keypair", log, auth, scope("pq:use"), async (req, res) => {
    try {
      const body = req.body || {};
      const level = resolveLevel(body.level);
      const { publicKey, secretKey } = generateKyberKeyPair(level);
      return res.status(201).json({
        _version: 1,
        level,
        publicKey: serializeKyberKey(publicKey),
        secretKey: serializeKyberKey(secretKey),
        publicKeyBytes: publicKey.length,
        secretKeyBytes: secretKey.length,
        warning:
          "Transitional hybrid stub — see lib/pq-kyber.js. Do not rely on quantum resistance.",
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/kyber/encapsulate
  apiRoute("post", "/pq/kyber/encapsulate", log, auth, scope("pq:use"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.publicKey || typeof body.publicKey !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "publicKey (base64) is required");
      }
      const level = resolveLevel(body.level);
      const pk = deserializeKyberKey(body.publicKey);
      const { ciphertext, sharedSecret, level: outLevel } = kyberEncapsulate(pk, level);
      return res.json({
        _version: 1,
        level: outLevel,
        ciphertext: serializeKyberKey(ciphertext),
        sharedSecret: serializeKyberKey(sharedSecret),
        ciphertextBytes: ciphertext.length,
        sharedSecretBytes: sharedSecret.length,
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/kyber/decapsulate
  apiRoute("post", "/pq/kyber/decapsulate", log, auth, scope("pq:use"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.ciphertext || typeof body.ciphertext !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "ciphertext (base64) is required");
      }
      if (!body.secretKey || typeof body.secretKey !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "secretKey (base64) is required");
      }
      const level = resolveLevel(body.level);
      const ct = deserializeKyberKey(body.ciphertext);
      const sk = deserializeKyberKey(body.secretKey);
      const sharedSecret = kyberDecapsulate(ct, sk, level);
      return res.json({
        _version: 1,
        level,
        sharedSecret: serializeKyberKey(sharedSecret),
        sharedSecretBytes: sharedSecret.length,
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountPqKyberRoutes;
