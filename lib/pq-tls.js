/**
 * Phase 50.3: Hybrid classical + post-quantum TLS configuration helpers.
 *
 * Node.js does not yet natively support hybrid classical+PQ TLS key exchange
 * (e.g. X25519Kyber768Draft00, X25519MLKEM768). This module implements a
 * configuration and capability-detection layer that:
 *
 *   1. Detects what TLS options / groups are available in the current
 *      Node.js and underlying OpenSSL build.
 *   2. Provides TLS option builders that prefer hybrid KEMs when supported
 *      and fall back to classical X25519 / secp384r1 / secp256r1 otherwise.
 *   3. Exposes health and recommendation helpers used by
 *      routes/pq-tls.js to surface PQ-readiness in the admin UI.
 *
 * Usage:
 *   import { buildHybridTlsOptions, getTlsHealthReport } from "./lib/pq-tls.js";
 *   const opts = buildHybridTlsOptions({ cert, key });
 *   const report = getTlsHealthReport();
 */

import tls from "node:tls";
import crypto from "node:crypto";
import https from "node:https";

// Known hybrid post-quantum KEM group identifiers. These names are published
// by IANA / the IETF TLS WG. When OpenSSL gains native support the detector
// will pick them up automatically via tls.getCurves() or the "groups" option.
export const HYBRID_PQ_GROUPS = [
  "X25519MLKEM768",           // draft-kwiatkowski-tls-ecdhe-mlkem (final)
  "X25519Kyber768Draft00",    // draft-ietf-tls-hybrid-design (Chrome / BoringSSL)
  "SecP256r1MLKEM768",
  "SecP384r1MLKEM1024",
];

// Pure post-quantum KEM group identifiers. Standalone, no classical fallback.
export const PURE_PQ_GROUPS = [
  "MLKEM512",
  "MLKEM768",
  "MLKEM1024",
];

// Classical key-agreement groups we fall back to today.
export const CLASSICAL_GROUPS = [
  "X25519",
  "secp384r1",
  "secp256r1",
];

// Modern AEAD-only TLS 1.3 cipher suites (ordering matters: preferred first).
export const MODERN_TLS13_CIPHERS = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
];

// Legacy TLS versions we explicitly disable via secureOptions bitmask.
// SSL_OP_NO_SSLv2 / SSL_OP_NO_SSLv3 / SSL_OP_NO_TLSv1 / SSL_OP_NO_TLSv1_1
function legacySecureOptionsMask() {
  const c = crypto.constants || {};
  let mask = 0;
  if (typeof c.SSL_OP_NO_SSLv2 === "number") mask |= c.SSL_OP_NO_SSLv2;
  if (typeof c.SSL_OP_NO_SSLv3 === "number") mask |= c.SSL_OP_NO_SSLv3;
  if (typeof c.SSL_OP_NO_TLSv1 === "number") mask |= c.SSL_OP_NO_TLSv1;
  if (typeof c.SSL_OP_NO_TLSv1_1 === "number") mask |= c.SSL_OP_NO_TLSv1_1;
  return mask;
}

/**
 * Detect what post-quantum and classical TLS capabilities the current
 * Node.js build exposes. This is best-effort: OpenSSL exposes its supported
 * groups via EC curve enumeration, but hybrid KEMs may not appear there
 * until the underlying library ships them.
 *
 * @returns {{
 *   nativePqKem: boolean,
 *   nodeVersion: string,
 *   openSSLVersion: string|null,
 *   supportedGroups: string[],
 *   hybridGroupsAvailable: string[],
 *   pureGroupsAvailable: string[],
 *   classicalGroupsAvailable: string[],
 *   supportedSigSchemes: string[],
 *   tlsMinVersion: string,
 *   tlsMaxVersion: string,
 *   defaultCiphers: string,
 *   detectedAt: string
 * }}
 */
export function detectPqCapabilities() {
  // tls.getCurves() returns the EC curves / groups OpenSSL knows about.
  // On Node 18+ this is reliable; on older builds it may be missing.
  let supportedGroups = [];
  try {
    if (typeof tls.getCurves === "function") {
      supportedGroups = tls.getCurves().slice();
    }
  } catch {
    supportedGroups = [];
  }

  const normalizedGroups = supportedGroups.map((g) => String(g));
  const lowerSet = new Set(normalizedGroups.map((g) => g.toLowerCase()));

  const hybridGroupsAvailable = HYBRID_PQ_GROUPS.filter((g) =>
    lowerSet.has(g.toLowerCase())
  );
  const pureGroupsAvailable = PURE_PQ_GROUPS.filter((g) =>
    lowerSet.has(g.toLowerCase())
  );
  const classicalGroupsAvailable = CLASSICAL_GROUPS.filter((g) =>
    lowerSet.has(g.toLowerCase())
  );

  const nativePqKem = hybridGroupsAvailable.length > 0 || pureGroupsAvailable.length > 0;

  // Signature schemes aren't directly enumerable in Node today, but OpenSSL
  // 3.2+ exposes ML-DSA (Dilithium) via getHashes/getCiphers indirectly.
  // We report the list we would prefer if available.
  const supportedSigSchemes = [];
  try {
    const hashes = crypto.getHashes ? crypto.getHashes() : [];
    // Node doesn't expose "sigSchemes" directly, so use hash list as a proxy
    // for what OpenSSL advertises.
    for (const h of hashes) {
      if (/^(rsa|ecdsa|ed25519|ed448|ml-dsa|dilithium|sphincs)/i.test(h)) {
        supportedSigSchemes.push(h);
      }
    }
  } catch {
    // ignore
  }

  return {
    nativePqKem,
    nodeVersion: process.versions?.node || "unknown",
    openSSLVersion: process.versions?.openssl || null,
    supportedGroups: normalizedGroups,
    hybridGroupsAvailable,
    pureGroupsAvailable,
    classicalGroupsAvailable,
    supportedSigSchemes,
    tlsMinVersion: tls.DEFAULT_MIN_VERSION || "TLSv1.2",
    tlsMaxVersion: tls.DEFAULT_MAX_VERSION || "TLSv1.3",
    defaultCiphers: tls.DEFAULT_CIPHERS || "",
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Build a set of tls.SecureContextOptions that:
 *   - Disable SSLv2, SSLv3, TLSv1.0, TLSv1.1 via secureOptions bitmask
 *   - Force TLSv1.3 as minimum
 *   - Prefer hybrid post-quantum KEM groups when OpenSSL advertises them,
 *     otherwise fall back to X25519 + NIST P-384 + NIST P-256
 *   - Restrict ciphers to modern AEAD TLS 1.3 suites
 *   - Honor caller-provided overrides (user options win over defaults)
 *
 * @param {import("node:tls").SecureContextOptions} [userOptions]
 * @returns {import("node:tls").SecureContextOptions}
 */
export function buildHybridTlsOptions(userOptions = {}) {
  const caps = detectPqCapabilities();

  // Compose curve preference string. Node tls uses ":" separators for
  // ecdhCurve. We always put hybrid PQ groups first so that, as soon as
  // OpenSSL starts advertising them, clients that support them will
  // negotiate a hybrid handshake with zero code change.
  const preferredCurves = [
    ...caps.hybridGroupsAvailable,
    ...caps.pureGroupsAvailable,
    ...CLASSICAL_GROUPS,
  ];
  const ecdhCurve = preferredCurves.join(":");

  const ciphers = MODERN_TLS13_CIPHERS.join(":");

  const baseOptions = {
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ecdhCurve,
    ciphers,
    honorCipherOrder: true,
    secureOptions: legacySecureOptionsMask(),
  };

  // User overrides win. Merge shallowly but combine secureOptions bitmasks
  // so callers can add flags without losing our legacy-disable bits.
  const merged = { ...baseOptions, ...userOptions };
  if (typeof userOptions.secureOptions === "number") {
    merged.secureOptions = baseOptions.secureOptions | userOptions.secureOptions;
  }
  return merged;
}

/**
 * Inspect current capabilities and return a human-readable list of
 * recommendations for upgrading PQ TLS readiness.
 *
 * @returns {{ ready: boolean, recommendations: string[], capabilities: object }}
 */
export function recommendPqUpgrades() {
  const caps = detectPqCapabilities();
  const recommendations = [];
  let ready = true;

  if (!caps.nativePqKem) {
    ready = false;
    recommendations.push(
      "Node.js and underlying OpenSSL do not expose any hybrid post-quantum KEM groups. " +
        "Upgrade to Node.js 24+ built against OpenSSL 3.5+ (or a distro build with oqsprovider) " +
        "to enable hybrid handshakes."
    );
  }

  if (caps.hybridGroupsAvailable.length === 0) {
    recommendations.push(
      "No hybrid KEM groups (X25519MLKEM768, X25519Kyber768Draft00) detected. " +
        "Hybrid handshakes provide both classical and PQ security in a single round trip."
    );
  }

  if (caps.classicalGroupsAvailable.length === 0) {
    // getCurves() missing or empty — detection failed, but classical is
    // still used by default. Surface as a diagnostic.
    recommendations.push(
      "Could not enumerate classical ECDH groups via tls.getCurves(). " +
        "Classical TLS will still work using OpenSSL defaults, but capability reporting is limited."
    );
  }

  if (caps.tlsMinVersion !== "TLSv1.3") {
    recommendations.push(
      `Default TLS minimum is ${caps.tlsMinVersion}. Set minVersion: "TLSv1.3" to " +
        "ensure only TLS 1.3 (where hybrid KEMs are defined) is negotiated.`
    );
  }

  const openssl = String(caps.openSSLVersion || "");
  const major = parseInt(openssl.split(".")[0], 10);
  const minor = parseInt(openssl.split(".")[1], 10);
  if (!openssl) {
    recommendations.push("OpenSSL version not reported by Node.js — cannot assess PQ readiness.");
    ready = false;
  } else if (major < 3 || (major === 3 && minor < 2)) {
    recommendations.push(
      `OpenSSL ${openssl} predates 3.2. Upgrade to OpenSSL 3.5+ for built-in ML-KEM / ML-DSA support.`
    );
    ready = false;
  }

  if (caps.supportedSigSchemes.length === 0) {
    recommendations.push(
      "No signature schemes enumerated. Consider linking oqsprovider or upgrading OpenSSL " +
        "to gain access to ML-DSA (Dilithium) and SLH-DSA (SPHINCS+) for PQ certificates."
    );
  }

  return { ready, recommendations, capabilities: caps };
}

/**
 * Connect to a remote TLS endpoint and report the negotiated protocol,
 * cipher, and certificate details. Useful for probing whether a deployed
 * service (or upstream) has successfully upgraded its TLS stack.
 *
 * @param {string} hostname
 * @param {number} [port=443]
 * @param {{ timeoutMs?: number, servername?: string }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   hostname: string,
 *   port: number,
 *   protocol: string|null,
 *   cipher: object|null,
 *   authorized: boolean|null,
 *   authorizationError: string|null,
 *   peerCertificate: { subject: object|null, issuer: object|null, validFrom: string|null, validTo: string|null }|null,
 *   error: string|null,
 *   durationMs: number
 * }>}
 */
export function testTlsEndpoint(hostname, port = 443, opts = {}) {
  const started = Date.now();
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 5000;

  return new Promise((resolve) => {
    if (!hostname || typeof hostname !== "string") {
      resolve({
        ok: false,
        hostname: String(hostname || ""),
        port,
        protocol: null,
        cipher: null,
        authorized: null,
        authorizationError: null,
        peerCertificate: null,
        error: "hostname is required",
        durationMs: Date.now() - started,
      });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: opts.servername || hostname,
        // We do NOT set rejectUnauthorized:false — we want to report the
        // real state of the cert chain. If the caller passes a custom
        // ca/rejectUnauthorized via opts they win.
        ...opts,
      },
      () => {
        try {
          const protocol = socket.getProtocol?.() || null;
          const cipher = socket.getCipher?.() || null;
          const cert = socket.getPeerCertificate?.() || null;
          const authorized = socket.authorized ?? null;
          const authorizationError = socket.authorizationError
            ? String(socket.authorizationError)
            : null;
          const peerCertificate = cert
            ? {
                subject: cert.subject || null,
                issuer: cert.issuer || null,
                validFrom: cert.valid_from || null,
                validTo: cert.valid_to || null,
              }
            : null;
          finish({
            ok: true,
            hostname,
            port,
            protocol,
            cipher,
            authorized,
            authorizationError,
            peerCertificate,
            error: null,
            durationMs: Date.now() - started,
          });
        } catch (err) {
          finish({
            ok: false,
            hostname,
            port,
            protocol: null,
            cipher: null,
            authorized: null,
            authorizationError: null,
            peerCertificate: null,
            error: err?.message || "unknown error",
            durationMs: Date.now() - started,
          });
        } finally {
          try {
            socket.end();
          } catch {
            // ignore
          }
        }
      }
    );

    socket.setTimeout(timeoutMs, () => {
      try {
        socket.destroy(new Error(`TLS connection timed out after ${timeoutMs}ms`));
      } catch {
        // ignore
      }
    });

    socket.on("error", (err) => {
      finish({
        ok: false,
        hostname,
        port,
        protocol: null,
        cipher: null,
        authorized: null,
        authorizationError: null,
        peerCertificate: null,
        error: err?.message || "tls error",
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Aggregate capability detection, recommendations, and a summary verdict
 * into a structured health report suitable for JSON serialization.
 *
 * @returns {{
 *   status: "ready"|"not-ready",
 *   summary: string,
 *   capabilities: object,
 *   recommendations: string[],
 *   tlsOptionsPreview: object,
 *   generatedAt: string
 * }}
 */
export function getTlsHealthReport() {
  const { ready, recommendations, capabilities } = recommendPqUpgrades();
  const tlsOptionsPreview = buildHybridTlsOptions();
  const status = ready ? "ready" : "not-ready";
  const summary = ready
    ? `Hybrid PQ TLS ready on Node ${capabilities.nodeVersion} / OpenSSL ${capabilities.openSSLVersion}.`
    : `Hybrid PQ TLS not yet available on Node ${capabilities.nodeVersion} / OpenSSL ${capabilities.openSSLVersion}. ` +
      `Using classical fallback (${CLASSICAL_GROUPS.join(", ")}).`;
  return {
    status,
    summary,
    capabilities,
    recommendations,
    tlsOptionsPreview: {
      minVersion: tlsOptionsPreview.minVersion,
      maxVersion: tlsOptionsPreview.maxVersion,
      ecdhCurve: tlsOptionsPreview.ecdhCurve,
      ciphers: tlsOptionsPreview.ciphers,
      honorCipherOrder: tlsOptionsPreview.honorCipherOrder,
      secureOptions: tlsOptionsPreview.secureOptions,
    },
    generatedAt: new Date().toISOString(),
  };
}

// Re-export https for callers that want to build an agent/server with
// the same options without importing both modules separately.
export { https };
