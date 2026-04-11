/**
 * Phase 36.1: Tests for lib/mtls.js — config loading, cert validation, middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadMtlsConfig,
  createMtlsHttpsOptions,
  createMtlsClientOptions,
  validateClientCert,
  mtlsMiddleware,
} from "../lib/mtls.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempCerts() {
  const dir = mkdtempSync(join(tmpdir(), "mtls-test-"));
  const files = {
    ca: join(dir, "ca.pem"),
    serverCert: join(dir, "server.crt"),
    serverKey: join(dir, "server.key"),
    clientCert: join(dir, "client.crt"),
    clientKey: join(dir, "client.key"),
    dir,
  };
  writeFileSync(files.ca, "-----BEGIN CERTIFICATE-----\nFAKE-CA\n-----END CERTIFICATE-----\n");
  writeFileSync(files.serverCert, "-----BEGIN CERTIFICATE-----\nFAKE-SERVER\n-----END CERTIFICATE-----\n");
  writeFileSync(files.serverKey, "-----BEGIN PRIVATE KEY-----\nFAKE-SERVER-KEY\n-----END PRIVATE KEY-----\n");
  writeFileSync(files.clientCert, "-----BEGIN CERTIFICATE-----\nFAKE-CLIENT\n-----END CERTIFICATE-----\n");
  writeFileSync(files.clientKey, "-----BEGIN PRIVATE KEY-----\nFAKE-CLIENT-KEY\n-----END PRIVATE KEY-----\n");
  return files;
}

function withMtlsEnv(files, fn) {
  const orig = {
    ca: process.env.MTLS_CA_CERT,
    sc: process.env.MTLS_SERVER_CERT,
    sk: process.env.MTLS_SERVER_KEY,
    cc: process.env.MTLS_CLIENT_CERT,
    ck: process.env.MTLS_CLIENT_KEY,
    cn: process.env.MTLS_ALLOWED_CN,
  };
  process.env.MTLS_CA_CERT = files.ca;
  process.env.MTLS_SERVER_CERT = files.serverCert;
  process.env.MTLS_SERVER_KEY = files.serverKey;
  process.env.MTLS_CLIENT_CERT = files.clientCert;
  process.env.MTLS_CLIENT_KEY = files.clientKey;
  try {
    return fn();
  } finally {
    orig.ca === undefined ? delete process.env.MTLS_CA_CERT : (process.env.MTLS_CA_CERT = orig.ca);
    orig.sc === undefined ? delete process.env.MTLS_SERVER_CERT : (process.env.MTLS_SERVER_CERT = orig.sc);
    orig.sk === undefined ? delete process.env.MTLS_SERVER_KEY : (process.env.MTLS_SERVER_KEY = orig.sk);
    orig.cc === undefined ? delete process.env.MTLS_CLIENT_CERT : (process.env.MTLS_CLIENT_CERT = orig.cc);
    orig.ck === undefined ? delete process.env.MTLS_CLIENT_KEY : (process.env.MTLS_CLIENT_KEY = orig.ck);
    orig.cn === undefined ? delete process.env.MTLS_ALLOWED_CN : (process.env.MTLS_ALLOWED_CN = orig.cn);
  }
}

function buildSocket({ peer, authorized = true, authorizationError = null } = {}) {
  return {
    authorized,
    authorizationError,
    getPeerCertificate(raw) {
      if (!peer) return {};
      return raw ? peer : { ...peer, raw: undefined };
    },
  };
}

function buildRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

// ── Config loading ──────────────────────────────────────────────────────────

test("loadMtlsConfig: disabled when no env vars set", () => {
  const orig = { ...process.env };
  delete process.env.MTLS_CA_CERT;
  delete process.env.MTLS_SERVER_CERT;
  delete process.env.MTLS_SERVER_KEY;
  try {
    const cfg = loadMtlsConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.ca, null);
  } finally {
    for (const k of ["MTLS_CA_CERT", "MTLS_SERVER_CERT", "MTLS_SERVER_KEY"]) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  }
});

test("loadMtlsConfig: enabled and reads all cert files", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const cfg = loadMtlsConfig();
      assert.equal(cfg.enabled, true);
      assert.ok(cfg.ca);
      assert.ok(cfg.cert);
      assert.ok(cfg.key);
      assert.ok(cfg.clientCert);
      assert.ok(cfg.clientKey);
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("loadMtlsConfig: parses MTLS_ALLOWED_CN into array", () => {
  const files = makeTempCerts();
  const orig = process.env.MTLS_ALLOWED_CN;
  process.env.MTLS_ALLOWED_CN = "svc-a, svc-b ,svc-c";
  try {
    withMtlsEnv(files, () => {
      const cfg = loadMtlsConfig();
      assert.deepEqual(cfg.allowedCNs, ["svc-a", "svc-b", "svc-c"]);
    });
  } finally {
    if (orig === undefined) delete process.env.MTLS_ALLOWED_CN;
    else process.env.MTLS_ALLOWED_CN = orig;
    rmSync(files.dir, { recursive: true, force: true });
  }
});

// ── HTTPS options ───────────────────────────────────────────────────────────

test("createMtlsHttpsOptions: throws when not configured", () => {
  const orig = { ...process.env };
  delete process.env.MTLS_CA_CERT;
  delete process.env.MTLS_SERVER_CERT;
  delete process.env.MTLS_SERVER_KEY;
  try {
    assert.throws(() => createMtlsHttpsOptions(), /not configured/);
  } finally {
    for (const k of ["MTLS_CA_CERT", "MTLS_SERVER_CERT", "MTLS_SERVER_KEY"]) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  }
});

test("createMtlsHttpsOptions: returns expected shape when configured", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const opts = createMtlsHttpsOptions();
      assert.ok(opts.key);
      assert.ok(opts.cert);
      assert.ok(opts.ca);
      assert.equal(opts.requestCert, true);
      assert.equal(opts.rejectUnauthorized, true);
      assert.equal(opts.minVersion, "TLSv1.2");
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("createMtlsClientOptions: throws without client material", () => {
  const orig = { ...process.env };
  delete process.env.MTLS_CA_CERT;
  delete process.env.MTLS_CLIENT_CERT;
  delete process.env.MTLS_CLIENT_KEY;
  try {
    assert.throws(() => createMtlsClientOptions(), /client is not configured/);
  } finally {
    for (const k of ["MTLS_CA_CERT", "MTLS_CLIENT_CERT", "MTLS_CLIENT_KEY"]) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  }
});

test("createMtlsClientOptions: builds client options when configured", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const opts = createMtlsClientOptions();
      assert.ok(opts.ca);
      assert.ok(opts.cert);
      assert.ok(opts.key);
      assert.equal(opts.rejectUnauthorized, true);
      assert.equal(opts.keepAlive, true);
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

// ── validateClientCert ──────────────────────────────────────────────────────

test("validateClientCert: returns invalid when no TLS socket", () => {
  const req = {};
  const result = validateClientCert(req);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "no_tls_socket");
});

test("validateClientCert: returns invalid when no cert is presented", () => {
  const req = { socket: buildSocket({ peer: null }) };
  const result = validateClientCert(req);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "no_client_cert");
});

test("validateClientCert: rejects unauthorized chain", () => {
  const now = new Date();
  const req = {
    socket: buildSocket({
      peer: {
        subject: { CN: "svc-a" },
        issuer: { CN: "test-ca" },
        valid_from: new Date(now.getTime() - 1000).toUTCString(),
        valid_to: new Date(now.getTime() + 1000 * 60).toUTCString(),
        fingerprint256: "AA:BB",
        raw: Buffer.from("raw"),
      },
      authorized: false,
      authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
  };
  const result = validateClientCert(req);
  assert.equal(result.valid, false);
  assert.match(result.reason, /UNABLE_TO_VERIFY/);
});

test("validateClientCert: rejects expired cert", () => {
  const req = {
    socket: buildSocket({
      peer: {
        subject: { CN: "svc-a" },
        issuer: { CN: "test-ca" },
        valid_from: new Date(Date.now() - 1000 * 60 * 60 * 24).toUTCString(),
        valid_to: new Date(Date.now() - 1000 * 60).toUTCString(),
        raw: Buffer.from("raw"),
      },
    }),
  };
  const result = validateClientCert(req);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "cert_expired");
});

test("validateClientCert: rejects not-yet-valid cert", () => {
  const req = {
    socket: buildSocket({
      peer: {
        subject: { CN: "svc-a" },
        issuer: { CN: "test-ca" },
        valid_from: new Date(Date.now() + 1000 * 60 * 60).toUTCString(),
        valid_to: new Date(Date.now() + 1000 * 60 * 60 * 2).toUTCString(),
        raw: Buffer.from("raw"),
      },
    }),
  };
  const result = validateClientCert(req);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "cert_not_yet_valid");
});

test("validateClientCert: accepts valid cert and returns fingerprint", () => {
  const req = {
    socket: buildSocket({
      peer: {
        subject: { CN: "svc-a" },
        issuer: { CN: "test-ca" },
        valid_from: new Date(Date.now() - 1000 * 60).toUTCString(),
        valid_to: new Date(Date.now() + 1000 * 60 * 60).toUTCString(),
        fingerprint256: "11:22:33",
        raw: Buffer.from("rawbytes"),
      },
    }),
  };
  const result = validateClientCert(req);
  assert.equal(result.valid, true);
  assert.equal(result.subject.CN, "svc-a");
  assert.equal(result.fingerprint, "11:22:33");
});

test("validateClientCert: computes fingerprint from raw DER when fingerprint256 is absent", () => {
  const req = {
    socket: buildSocket({
      peer: {
        subject: { CN: "svc-a" },
        issuer: { CN: "test-ca" },
        valid_from: new Date(Date.now() - 1000 * 60).toUTCString(),
        valid_to: new Date(Date.now() + 1000 * 60 * 60).toUTCString(),
        raw: Buffer.from("rawbytes"),
      },
    }),
  };
  const result = validateClientCert(req);
  assert.equal(result.valid, true);
  assert.ok(result.fingerprint);
  assert.match(result.fingerprint, /^[0-9A-F:]+$/);
});

// ── mtlsMiddleware ──────────────────────────────────────────────────────────

test("mtlsMiddleware: returns 503 when not configured and allowUnconfigured=false", () => {
  const orig = { ...process.env };
  delete process.env.MTLS_CA_CERT;
  delete process.env.MTLS_SERVER_CERT;
  delete process.env.MTLS_SERVER_KEY;
  try {
    const mw = mtlsMiddleware();
    const res = buildRes();
    let nextCalled = false;
    mw({}, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "MTLS_NOT_CONFIGURED");
  } finally {
    for (const k of ["MTLS_CA_CERT", "MTLS_SERVER_CERT", "MTLS_SERVER_KEY"]) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  }
});

test("mtlsMiddleware: passes through when not configured and allowUnconfigured=true", () => {
  const orig = { ...process.env };
  delete process.env.MTLS_CA_CERT;
  delete process.env.MTLS_SERVER_CERT;
  delete process.env.MTLS_SERVER_KEY;
  try {
    const mw = mtlsMiddleware({ allowUnconfigured: true });
    const res = buildRes();
    let called = false;
    mw({}, res, () => {
      called = true;
    });
    assert.equal(called, true);
  } finally {
    for (const k of ["MTLS_CA_CERT", "MTLS_SERVER_CERT", "MTLS_SERVER_KEY"]) {
      if (orig[k] !== undefined) process.env[k] = orig[k];
    }
  }
});

test("mtlsMiddleware: 401 when configured but no client cert", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const mw = mtlsMiddleware();
      const req = { socket: buildSocket({ peer: null }) };
      const res = buildRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, "MTLS_CLIENT_CERT_REQUIRED");
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("mtlsMiddleware: 403 when CN is not in allowlist", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const mw = mtlsMiddleware({ allowedCNs: ["svc-b"] });
      const req = {
        socket: buildSocket({
          peer: {
            subject: { CN: "svc-a" },
            issuer: { CN: "test-ca" },
            valid_from: new Date(Date.now() - 1000 * 60).toUTCString(),
            valid_to: new Date(Date.now() + 1000 * 60 * 60).toUTCString(),
            raw: Buffer.from("raw"),
          },
        }),
      };
      const res = buildRes();
      mw(req, res, () => {});
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, "MTLS_CN_NOT_ALLOWED");
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("mtlsMiddleware: passes and attaches req.mtls when valid", () => {
  const files = makeTempCerts();
  try {
    withMtlsEnv(files, () => {
      const mw = mtlsMiddleware({ allowedCNs: ["svc-a"] });
      const req = {
        socket: buildSocket({
          peer: {
            subject: { CN: "svc-a" },
            issuer: { CN: "test-ca" },
            valid_from: new Date(Date.now() - 1000 * 60).toUTCString(),
            valid_to: new Date(Date.now() + 1000 * 60 * 60).toUTCString(),
            fingerprint256: "DE:AD:BE:EF",
            raw: Buffer.from("raw"),
          },
        }),
      };
      const res = buildRes();
      let called = false;
      mw(req, res, () => {
        called = true;
      });
      assert.equal(called, true);
      assert.equal(req.mtls.subject.CN, "svc-a");
      assert.equal(req.mtls.fingerprint, "DE:AD:BE:EF");
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});
