/**
 * Phase 36.1: Mutual TLS (mTLS) setup for internal service-to-service communication.
 *
 * Loads certificate material from the environment, builds options for HTTPS servers
 * and outbound clients, validates peer certificates, and exposes an Express
 * middleware that rejects requests without a valid client cert.
 *
 * Environment variables:
 *   MTLS_CA_CERT      - Path to CA certificate (PEM) used to verify peers.
 *   MTLS_CLIENT_CERT  - Path to client certificate (PEM) for outbound calls.
 *   MTLS_CLIENT_KEY   - Path to client private key (PEM) for outbound calls.
 *   MTLS_SERVER_CERT  - Path to server certificate (PEM).
 *   MTLS_SERVER_KEY   - Path to server private key (PEM).
 *   MTLS_ALLOWED_CN   - Optional comma-separated list of allowed client CNs.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";

/**
 * Read a file into a Buffer/string if the path is set. Returns null otherwise.
 */
function readIfPresent(path) {
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch (err) {
    console.warn(`[mtls] Failed to read ${path}: ${err.message}`);
    return null;
  }
}

/**
 * Load mTLS configuration from environment variables.
 * Returns { ca, cert, key, clientCert, clientKey, allowedCNs, enabled }.
 * `enabled` is true only when a server cert+key and CA are all available.
 */
export function loadMtlsConfig() {
  const ca = readIfPresent(process.env.MTLS_CA_CERT);
  const cert = readIfPresent(process.env.MTLS_SERVER_CERT);
  const key = readIfPresent(process.env.MTLS_SERVER_KEY);
  const clientCert = readIfPresent(process.env.MTLS_CLIENT_CERT);
  const clientKey = readIfPresent(process.env.MTLS_CLIENT_KEY);

  const allowedCNs = (process.env.MTLS_ALLOWED_CN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const enabled = Boolean(ca && cert && key);

  return {
    ca,
    cert,
    key,
    clientCert,
    clientKey,
    allowedCNs,
    enabled,
  };
}

/**
 * Build https.createServer options for an mTLS server.
 * Throws if required material is missing.
 */
export function createMtlsHttpsOptions(config) {
  const cfg = config || loadMtlsConfig();
  if (!cfg.enabled) {
    throw new Error("mTLS is not configured: set MTLS_CA_CERT, MTLS_SERVER_CERT, and MTLS_SERVER_KEY.");
  }
  return {
    key: cfg.key,
    cert: cfg.cert,
    ca: cfg.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };
}

/**
 * Build https.Agent options for outbound mTLS requests.
 * Returns an options object suitable for `new https.Agent(opts)`.
 */
export function createMtlsClientOptions(config) {
  const cfg = config || loadMtlsConfig();
  if (!cfg.ca || !cfg.clientCert || !cfg.clientKey) {
    throw new Error(
      "mTLS client is not configured: set MTLS_CA_CERT, MTLS_CLIENT_CERT, and MTLS_CLIENT_KEY."
    );
  }
  return {
    ca: cfg.ca,
    cert: cfg.clientCert,
    key: cfg.clientKey,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    keepAlive: true,
  };
}

/**
 * Compute a SHA-256 fingerprint of a raw DER cert buffer as colon-separated hex.
 */
function fingerprintDer(raw) {
  if (!raw) return null;
  const hex = createHash("sha256").update(raw).digest("hex").toUpperCase();
  return hex.match(/.{1,2}/g).join(":");
}

/**
 * Extract and validate the peer client certificate from an Express request.
 *
 * @param {import("express").Request} req
 * @returns {{ valid: boolean, reason?: string, subject?: object, issuer?: object, fingerprint?: string|null }}
 */
export function validateClientCert(req) {
  const socket = req?.socket || req?.connection;
  if (!socket || typeof socket.getPeerCertificate !== "function") {
    return { valid: false, reason: "no_tls_socket" };
  }

  // The raw flag yields the DER bytes so we can re-fingerprint deterministically.
  const cert = socket.getPeerCertificate(true);
  if (!cert || Object.keys(cert).length === 0) {
    return { valid: false, reason: "no_client_cert" };
  }

  // Trust chain must have been verified by TLS stack.
  if (typeof socket.authorized === "boolean" && !socket.authorized) {
    return {
      valid: false,
      reason: socket.authorizationError ? String(socket.authorizationError) : "not_authorized",
      subject: cert.subject,
      issuer: cert.issuer,
      fingerprint: cert.fingerprint256 || fingerprintDer(cert.raw),
    };
  }

  // Expiry checks (validity window).
  const now = Date.now();
  const validFrom = cert.valid_from ? Date.parse(cert.valid_from) : null;
  const validTo = cert.valid_to ? Date.parse(cert.valid_to) : null;
  if (validFrom && now < validFrom) {
    return { valid: false, reason: "cert_not_yet_valid", subject: cert.subject, issuer: cert.issuer };
  }
  if (validTo && now > validTo) {
    return { valid: false, reason: "cert_expired", subject: cert.subject, issuer: cert.issuer };
  }

  return {
    valid: true,
    subject: cert.subject || {},
    issuer: cert.issuer || {},
    fingerprint: cert.fingerprint256 || fingerprintDer(cert.raw),
  };
}

/**
 * Express middleware that enforces a valid client certificate.
 *
 * Options:
 *   allowedCNs          - Array of allowed subject CNs. Defaults to MTLS_ALLOWED_CN.
 *   allowUnconfigured   - If true and mTLS is not configured, pass-through (default false).
 */
export function mtlsMiddleware(options = {}) {
  const config = options.config || loadMtlsConfig();
  const allowedCNs = options.allowedCNs || config.allowedCNs || [];
  const allowUnconfigured = options.allowUnconfigured === true;

  return function mtlsMiddlewareHandler(req, res, next) {
    if (!config.enabled) {
      if (allowUnconfigured) return next();
      return res.status(503).json({
        error: "mTLS not configured",
        code: "MTLS_NOT_CONFIGURED",
        hint: "Set MTLS_CA_CERT, MTLS_SERVER_CERT, and MTLS_SERVER_KEY.",
      });
    }

    const result = validateClientCert(req);
    if (!result.valid) {
      return res.status(401).json({
        error: "Client certificate required",
        code: "MTLS_CLIENT_CERT_REQUIRED",
        reason: result.reason || "invalid_cert",
      });
    }

    if (allowedCNs.length > 0) {
      const cn = result.subject?.CN;
      if (!cn || !allowedCNs.includes(cn)) {
        return res.status(403).json({
          error: "Client certificate CN is not allowed",
          code: "MTLS_CN_NOT_ALLOWED",
          cn: cn || null,
        });
      }
    }

    req.mtls = {
      subject: result.subject,
      issuer: result.issuer,
      fingerprint: result.fingerprint,
    };
    return next();
  };
}
