/**
 * Phase 50.2: CRYSTALS-Dilithium (ML-DSA) post-quantum signature routes.
 *
 * Endpoints:
 *   POST /api/v1/pq/dilithium/keypair   — generate a key pair
 *   POST /api/v1/pq/dilithium/sign      — sign a message with a secret key
 *   POST /api/v1/pq/dilithium/verify    — verify a signature
 *   GET  /api/v1/pq/dilithium/info      — metadata about supported levels
 *
 * Request/response encoding: all binary values (keys, signatures, messages)
 * are exchanged as base64 strings. Messages may alternatively be supplied as
 * plain UTF-8 via a `messageText` field for convenience.
 */
import {
  DILITHIUM_LEVELS,
  generateDilithiumKeyPair,
  dilithiumSign,
  dilithiumVerify,
  serializeDilithiumKey,
  deserializeDilithiumKey,
  listDilithiumLevels,
} from "../lib/pq-dilithium.js";

const DEFAULT_LEVEL = "ml-dsa-65";

function normalizeLevel(level) {
  if (level === undefined || level === null || level === "") return DEFAULT_LEVEL;
  if (typeof level !== "string") return null;
  return DILITHIUM_LEVELS[level] ? level : null;
}

function decodeMessage(body) {
  if (typeof body?.messageText === "string") {
    return Buffer.from(body.messageText, "utf8");
  }
  if (typeof body?.message === "string") {
    // Default: treat `message` as base64. Callers wanting UTF-8 should use
    // `messageText`. We accept both so curl users can pass either.
    return Buffer.from(body.message, "base64");
  }
  return null;
}

export function mountPqDilithiumRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  const BASE = "/pq/dilithium";

  // ---- GET /api/v1/pq/dilithium/info ------------------------------------

  apiRoute("get", `${BASE}/info`, log, auth, scope("read"), async (_req, res) => {
    try {
      const levels = listDilithiumLevels();
      return res.json({
        _version: 1,
        algorithm: "CRYSTALS-Dilithium (ML-DSA, FIPS 204)",
        defaultLevel: DEFAULT_LEVEL,
        levels,
        note:
          "This is a transitional API-compatible stub using SHAKE256/SHA3-256. " +
          "For production post-quantum JWT signing, back this with @noble/post-quantum " +
          "or a WebAssembly-compiled liboqs binding.",
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "info failed");
    }
  });

  // ---- POST /api/v1/pq/dilithium/keypair --------------------------------

  apiRoute("post", `${BASE}/keypair`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const level = normalizeLevel(body.level);
      if (!level) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `level must be one of: ${Object.keys(DILITHIUM_LEVELS).join(", ")}`,
        );
      }
      const kp = generateDilithiumKeyPair(level);
      return res.status(201).json({
        _version: 1,
        level: kp.level,
        publicKey: serializeDilithiumKey(kp.publicKey),
        secretKey: serializeDilithiumKey(kp.secretKey),
      });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "keypair generation failed",
      );
    }
  });

  // ---- POST /api/v1/pq/dilithium/sign -----------------------------------

  apiRoute("post", `${BASE}/sign`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const level = normalizeLevel(body.level);
      if (!level) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `level must be one of: ${Object.keys(DILITHIUM_LEVELS).join(", ")}`,
        );
      }
      if (!body.secretKey || typeof body.secretKey !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "secretKey (base64) is required");
      }
      const msgBuf = decodeMessage(body);
      if (!msgBuf) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "message (base64) or messageText (utf-8 string) is required",
        );
      }
      let sk;
      try {
        sk = deserializeDilithiumKey(body.secretKey);
      } catch (e) {
        return apiError(res, 400, "INVALID_INPUT", `invalid secretKey: ${e.message}`);
      }
      let sig;
      try {
        sig = dilithiumSign(msgBuf, sk, level);
      } catch (e) {
        return apiError(res, 400, "INVALID_INPUT", e.message || "sign failed");
      }
      return res.json({
        _version: 1,
        level,
        signature: serializeDilithiumKey(sig),
        signatureSize: sig.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "sign failed");
    }
  });

  // ---- POST /api/v1/pq/dilithium/verify ---------------------------------

  apiRoute("post", `${BASE}/verify`, log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const level = normalizeLevel(body.level);
      if (!level) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `level must be one of: ${Object.keys(DILITHIUM_LEVELS).join(", ")}`,
        );
      }
      if (!body.publicKey || typeof body.publicKey !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "publicKey (base64) is required");
      }
      if (!body.signature || typeof body.signature !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "signature (base64) is required");
      }
      const msgBuf = decodeMessage(body);
      if (!msgBuf) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "message (base64) or messageText (utf-8 string) is required",
        );
      }
      let pk;
      let sig;
      try {
        pk = deserializeDilithiumKey(body.publicKey);
        sig = deserializeDilithiumKey(body.signature);
      } catch (e) {
        return apiError(res, 400, "INVALID_INPUT", `invalid input: ${e.message}`);
      }
      const valid = dilithiumVerify(msgBuf, sig, pk, level);
      return res.json({ _version: 1, valid, level });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "verify failed");
    }
  });
}

export default mountPqDilithiumRoutes;
