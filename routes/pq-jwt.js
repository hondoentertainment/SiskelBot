/**
 * Phase 50.4: Post-quantum JWT signing routes.
 *
 * POST /api/v1/pq/jwt/sign      — admin only, sign a payload with a PQ key
 * POST /api/v1/pq/jwt/verify    — verify a compact JWS token
 * POST /api/v1/pq/jwt/decode    — unsafe decode (no signature verification)
 * POST /api/v1/pq/jwt/keypair   — admin only, generate a new keypair
 * GET  /api/v1/pq/jwt/algorithms — list supported PQ algorithms
 */
import {
  PQ_ALGORITHMS,
  DEFAULT_PQ_ALGORITHM,
  signPqJwt,
  verifyPqJwt,
  decodePqJwt,
  generatePqJwtKey,
} from "../lib/pq-jwt.js";

function badRequest(apiError, res, message) {
  return apiError(res, 400, "INVALID_INPUT", message);
}

export function mountPqJwtRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, requireScope, logRequest } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/pq/jwt/algorithms — public listing
  apiRoute("get", "/pq/jwt/algorithms", log, async (_req, res) => {
    return res.json({
      _version: 1,
      algorithms: PQ_ALGORITHMS,
      default: DEFAULT_PQ_ALGORITHM,
    });
  });

  // POST /api/v1/pq/jwt/keypair — admin only
  apiRoute("post", "/pq/jwt/keypair", log, admin, scope("admin"), async (req, res) => {
    try {
      const algorithm = req.body?.algorithm || DEFAULT_PQ_ALGORITHM;
      if (!PQ_ALGORITHMS.includes(algorithm)) {
        return badRequest(apiError, res, `unsupported algorithm: ${algorithm}`);
      }
      const key = await generatePqJwtKey(algorithm);
      return res.status(201).json({ _version: 1, key });
    } catch (err) {
      return apiError(res, 500, "PQ_JWT_ERROR", err?.message || "failed to generate keypair");
    }
  });

  // POST /api/v1/pq/jwt/sign — admin only
  apiRoute("post", "/pq/jwt/sign", log, admin, scope("admin"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.payload || typeof body.payload !== "object") {
        return badRequest(apiError, res, "payload is required and must be an object");
      }
      if (!body.secretKey || typeof body.secretKey !== "string") {
        return badRequest(apiError, res, "secretKey is required (base64url string)");
      }
      const options = {
        algorithm: body.algorithm || DEFAULT_PQ_ALGORITHM,
        kid: body.kid,
        issuer: body.issuer,
        subject: body.subject,
        audience: body.audience,
        expiresIn: body.expiresIn,
        notBefore: body.notBefore,
      };
      if (!PQ_ALGORITHMS.includes(options.algorithm)) {
        return badRequest(apiError, res, `unsupported algorithm: ${options.algorithm}`);
      }
      const token = await signPqJwt(body.payload, body.secretKey, options);
      return res.status(201).json({ _version: 1, token, algorithm: options.algorithm });
    } catch (err) {
      return apiError(res, 400, "PQ_JWT_SIGN_FAILED", err?.message || "sign failed");
    }
  });

  // POST /api/v1/pq/jwt/verify
  apiRoute("post", "/pq/jwt/verify", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.token || typeof body.token !== "string") {
        return badRequest(apiError, res, "token is required");
      }
      if (!body.publicKey || typeof body.publicKey !== "string") {
        return badRequest(apiError, res, "publicKey is required (base64url string)");
      }
      const options = {
        algorithms: Array.isArray(body.algorithms) ? body.algorithms : undefined,
        audience: body.audience,
        issuer: body.issuer,
        subject: body.subject,
        clockTolerance: body.clockTolerance,
        maxAge: body.maxAge,
      };
      const payload = await verifyPqJwt(body.token, body.publicKey, options);
      return res.json({ _version: 1, valid: true, payload });
    } catch (err) {
      return res.status(401).json({
        _version: 1,
        valid: false,
        error: err?.message || "verification failed",
      });
    }
  });

  // POST /api/v1/pq/jwt/decode — unsafe, no signature verification
  apiRoute("post", "/pq/jwt/decode", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.token || typeof body.token !== "string") {
        return badRequest(apiError, res, "token is required");
      }
      const decoded = decodePqJwt(body.token);
      return res.json({
        _version: 1,
        header: decoded.header,
        payload: decoded.payload,
        warning: "this endpoint does not verify the signature; do not trust the payload",
      });
    } catch (err) {
      return badRequest(apiError, res, err?.message || "decode failed");
    }
  });
}

export default mountPqJwtRoutes;
