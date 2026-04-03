/**
 * SSO integration tests — OIDC and SAML configuration, user mapping, and route registration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { _resetForTesting } from "../lib/auth.js";

// --- OIDC configuration tests ---

test("configureOIDC returns null when env vars missing", async () => {
  const { configureOIDC } = await import("../lib/oidc.js");
  const result = configureOIDC({ issuer: "", clientId: "", clientSecret: "" });
  assert.equal(result, null);
});

test("configureOIDC returns config when all required options provided", async () => {
  const { configureOIDC } = await import("../lib/oidc.js");
  const result = configureOIDC({
    issuer: "https://accounts.google.com",
    clientId: "test-client-id",
    clientSecret: "test-secret",
    redirectUri: "https://myapp.com/auth/oidc/callback",
    scopes: "openid email",
  });
  assert.ok(result);
  assert.equal(result.issuer, "https://accounts.google.com");
  assert.equal(result.clientId, "test-client-id");
  assert.equal(result.clientSecret, "test-secret");
  assert.equal(result.redirectUri, "https://myapp.com/auth/oidc/callback");
  assert.equal(result.scopes, "openid email");
});

test("configureOIDC uses default scopes when not specified", async () => {
  const { configureOIDC } = await import("../lib/oidc.js");
  const result = configureOIDC({
    issuer: "https://example.com",
    clientId: "cid",
    clientSecret: "csec",
  });
  assert.equal(result.scopes, "openid profile email");
});

test("configureOIDC uses default redirect URI when not specified", async () => {
  const { configureOIDC } = await import("../lib/oidc.js");
  const result = configureOIDC({
    issuer: "https://example.com",
    clientId: "cid",
    clientSecret: "csec",
  });
  assert.equal(result.redirectUri, "/auth/oidc/callback");
});

test("isOIDCConfigured returns false when env vars not set", async () => {
  const orig = { ...process.env };
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  const { isOIDCConfigured } = await import("../lib/oidc.js");
  assert.equal(isOIDCConfigured(), false);
  process.env = orig;
});

// --- OIDC user mapping tests ---

test("mapOIDCClaimsToUser maps standard claims", async () => {
  const { mapOIDCClaimsToUser } = await import("../lib/oidc.js");
  const user = mapOIDCClaimsToUser({
    sub: "user-123",
    name: "Alice Smith",
    email: "alice@example.com",
    preferred_username: "alice",
  });
  assert.equal(user.id, "user-123");
  assert.equal(user.displayName, "Alice Smith");
  assert.equal(user.email, "alice@example.com");
  assert.equal(user.provider, "oidc");
});

test("mapOIDCClaimsToUser falls back to preferred_username for displayName", async () => {
  const { mapOIDCClaimsToUser } = await import("../lib/oidc.js");
  const user = mapOIDCClaimsToUser({ sub: "u1", preferred_username: "bob" });
  assert.equal(user.displayName, "bob");
});

test("mapOIDCClaimsToUser throws when sub missing", async () => {
  const { mapOIDCClaimsToUser } = await import("../lib/oidc.js");
  assert.throws(() => mapOIDCClaimsToUser({}), /sub\/id/);
});

test("decodeJwtPayload decodes valid JWT payload", async () => {
  const { decodeJwtPayload } = await import("../lib/oidc.js");
  const payload = { sub: "test-sub", name: "Test" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${encoded}.fakesig`;
  const decoded = decodeJwtPayload(fakeJwt);
  assert.equal(decoded.sub, "test-sub");
  assert.equal(decoded.name, "Test");
});

test("decodeJwtPayload throws on invalid JWT", async () => {
  const { decodeJwtPayload } = await import("../lib/oidc.js");
  assert.throws(() => decodeJwtPayload("not-a-jwt"), /Invalid JWT/);
});

// --- SAML configuration tests ---

test("configureSAML returns null when env vars missing", async () => {
  const { configureSAML } = await import("../lib/saml.js");
  const result = configureSAML({ entryPoint: "", issuer: "" });
  assert.equal(result, null);
});

test("configureSAML returns config when required options provided", async () => {
  const { configureSAML } = await import("../lib/saml.js");
  const result = configureSAML({
    entryPoint: "https://idp.example.com/sso",
    issuer: "https://myapp.com",
    cert: "MIIDbase64cert",
    callbackUrl: "https://myapp.com/auth/saml/callback",
  });
  assert.ok(result);
  assert.equal(result.entryPoint, "https://idp.example.com/sso");
  assert.equal(result.issuer, "https://myapp.com");
  assert.equal(result.cert, "MIIDbase64cert");
  assert.equal(result.callbackUrl, "https://myapp.com/auth/saml/callback");
});

test("configureSAML uses default callback URL when not specified", async () => {
  const { configureSAML } = await import("../lib/saml.js");
  const result = configureSAML({
    entryPoint: "https://idp.example.com/sso",
    issuer: "https://myapp.com",
  });
  assert.equal(result.callbackUrl, "/auth/saml/callback");
});

test("isSAMLConfigured returns false when env vars not set", async () => {
  const orig = { ...process.env };
  delete process.env.SAML_ENTRY_POINT;
  delete process.env.SAML_ISSUER;
  const { isSAMLConfigured } = await import("../lib/saml.js");
  assert.equal(isSAMLConfigured(), false);
  process.env = orig;
});

// --- SAML user mapping tests ---

test("mapSAMLAttributesToUser maps standard SAML attributes", async () => {
  const { mapSAMLAttributesToUser } = await import("../lib/saml.js");
  const user = mapSAMLAttributesToUser({
    nameID: "user@example.com",
    displayName: "Alice Smith",
    email: "alice@example.com",
  });
  assert.equal(user.id, "user@example.com");
  assert.equal(user.displayName, "Alice Smith");
  assert.equal(user.email, "alice@example.com");
  assert.equal(user.provider, "saml");
});

test("mapSAMLAttributesToUser maps OID-based attributes", async () => {
  const { mapSAMLAttributesToUser } = await import("../lib/saml.js");
  const user = mapSAMLAttributesToUser({
    nameID: "jdoe",
    "urn:oid:2.16.840.1.113730.3.1.241": "John Doe",
    "urn:oid:0.9.2342.19200300.100.1.3": "jdoe@corp.com",
  });
  assert.equal(user.id, "jdoe");
  assert.equal(user.displayName, "John Doe");
  assert.equal(user.email, "jdoe@corp.com");
});

test("mapSAMLAttributesToUser maps WS-Federation claim URIs", async () => {
  const { mapSAMLAttributesToUser } = await import("../lib/saml.js");
  const user = mapSAMLAttributesToUser({
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "wsuser1",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "WS User",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "ws@example.com",
  });
  assert.equal(user.id, "wsuser1");
  assert.equal(user.displayName, "WS User");
  assert.equal(user.email, "ws@example.com");
});

test("mapSAMLAttributesToUser throws when no identifier found", async () => {
  const { mapSAMLAttributesToUser } = await import("../lib/saml.js");
  assert.throws(() => mapSAMLAttributesToUser({}), /no user identifier/);
});

test("mapSAMLAttributesToUser throws on null attributes", async () => {
  const { mapSAMLAttributesToUser } = await import("../lib/saml.js");
  assert.throws(() => mapSAMLAttributesToUser(null), /attributes missing/);
});

// --- SAML XML parsing tests ---

test("parseSAMLResponse extracts NameID and attributes", async () => {
  const { parseSAMLResponse } = await import("../lib/saml.js");
  const xml = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
      <saml:Assertion>
        <saml:Subject>
          <saml:NameID>alice@example.com</saml:NameID>
        </saml:Subject>
        <saml:AttributeStatement>
          <saml:Attribute Name="displayName">
            <saml:AttributeValue>Alice</saml:AttributeValue>
          </saml:Attribute>
          <saml:Attribute Name="email">
            <saml:AttributeValue>alice@example.com</saml:AttributeValue>
          </saml:Attribute>
        </saml:AttributeStatement>
      </saml:Assertion>
    </samlp:Response>`;
  const { nameID, attributes } = parseSAMLResponse(xml);
  assert.equal(nameID, "alice@example.com");
  assert.equal(attributes.nameID, "alice@example.com");
  assert.equal(attributes.displayName, "Alice");
  assert.equal(attributes.email, "alice@example.com");
});

test("parseSAMLResponse throws on empty input", async () => {
  const { parseSAMLResponse } = await import("../lib/saml.js");
  assert.throws(() => parseSAMLResponse(""), /empty/);
  assert.throws(() => parseSAMLResponse(null), /empty/);
});

// --- SAML metadata generation ---

test("generateMetadata returns valid XML with correct entityID and ACS URL", async () => {
  const { generateMetadata } = await import("../lib/saml.js");
  const xml = generateMetadata({ issuer: "https://myapp.com", callbackUrl: "https://myapp.com/auth/saml/callback" });
  assert.ok(xml.includes('entityID="https://myapp.com"'));
  assert.ok(xml.includes('Location="https://myapp.com/auth/saml/callback"'));
  assert.ok(xml.includes("SPSSODescriptor"));
  assert.ok(xml.includes("AssertionConsumerService"));
});

// --- SAML AuthnRequest ---

test("buildAuthnRequest includes issuer and callback URL", async () => {
  const { buildAuthnRequest } = await import("../lib/saml.js");
  const xml = buildAuthnRequest({
    issuer: "https://myapp.com",
    callbackUrl: "https://myapp.com/auth/saml/callback",
    id: "_test123",
  });
  assert.ok(xml.includes("https://myapp.com"));
  assert.ok(xml.includes("_test123"));
  assert.ok(xml.includes("AuthnRequest"));
});

// --- Route registration tests ---

test("configureSSO registers no routes when SSO not configured", async () => {
  const original = { ...process.env };
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.SAML_ENTRY_POINT;
  delete process.env.SAML_ISSUER;

  // Use a fresh import to avoid cached env
  const moduleUrl = new URL(`../lib/sso.js?t=${Date.now()}`, import.meta.url);
  const { configureSSO } = await import(moduleUrl.href);

  const routes = [];
  const fakeApp = {
    get(path) { routes.push({ method: "GET", path }); },
    post(path) { routes.push({ method: "POST", path }); },
  };
  const fakePassport = { use() {} };

  const result = configureSSO(fakeApp, fakePassport);
  assert.equal(result.oidc, false);
  assert.equal(result.saml, false);
  // No auth routes should be registered
  const authRoutes = routes.filter(r => r.path?.startsWith?.("/auth/"));
  assert.equal(authRoutes.length, 0);
  process.env = original;
});

test("configureSSO registers OIDC routes when configured", async () => {
  const original = { ...process.env };
  process.env.OIDC_ISSUER = "https://accounts.google.com";
  process.env.OIDC_CLIENT_ID = "test-id";
  process.env.OIDC_CLIENT_SECRET = "test-secret";
  delete process.env.SAML_ENTRY_POINT;
  delete process.env.SAML_ISSUER;

  const moduleUrl = new URL(`../lib/sso.js?t=${Date.now()}2`, import.meta.url);
  const { configureSSO } = await import(moduleUrl.href);

  const routes = [];
  const fakeApp = {
    get(path) { routes.push({ method: "GET", path }); },
    post(path) { routes.push({ method: "POST", path }); },
  };
  const strategies = [];
  const fakePassport = {
    use(s) { strategies.push(s); },
    authenticate() { return (_req, _res, _next) => {}; },
  };

  const result = configureSSO(fakeApp, fakePassport);
  assert.equal(result.oidc, true);
  assert.equal(result.saml, false);
  assert.ok(routes.some(r => r.path === "/auth/oidc"));
  assert.ok(routes.some(r => r.path === "/auth/oidc/callback"));
  process.env = original;
});

test("configureSSO registers SAML routes when configured", async () => {
  const original = { ...process.env };
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  process.env.SAML_ENTRY_POINT = "https://idp.example.com/sso";
  process.env.SAML_ISSUER = "https://myapp.com";

  const moduleUrl = new URL(`../lib/sso.js?t=${Date.now()}3`, import.meta.url);
  const { configureSSO } = await import(moduleUrl.href);

  const routes = [];
  const fakeApp = {
    get(path) { routes.push({ method: "GET", path }); },
    post(path) { routes.push({ method: "POST", path }); },
  };
  const strategies = [];
  const fakePassport = {
    use(s) { strategies.push(s); },
    authenticate() { return (_req, _res, _next) => {}; },
  };

  const result = configureSSO(fakeApp, fakePassport);
  assert.equal(result.oidc, false);
  assert.equal(result.saml, true);
  assert.ok(routes.some(r => r.path === "/auth/saml"));
  assert.ok(routes.some(r => r.path === "/auth/saml/callback"));
  assert.ok(routes.some(r => r.path === "/auth/saml/metadata"));
  process.env = original;
});

// --- isAuthConfigured includes SSO ---

test("isAuthConfigured returns true when OIDC configured", async () => {
  _resetForTesting();
  const original = { ...process.env };
  delete process.env.USER_API_KEYS;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.SAML_ENTRY_POINT;
  process.env.OIDC_ISSUER = "https://accounts.google.com";
  process.env.OIDC_CLIENT_ID = "cid";
  process.env.OIDC_CLIENT_SECRET = "csec";

  const { isAuthConfigured } = await import("../lib/auth.js");
  assert.equal(isAuthConfigured(), true);
  process.env = original;
  _resetForTesting();
});

test("isAuthConfigured returns true when SAML configured", async () => {
  _resetForTesting();
  const original = { ...process.env };
  delete process.env.USER_API_KEYS;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.OIDC_ISSUER;
  process.env.SAML_ENTRY_POINT = "https://idp.example.com/sso";
  process.env.SAML_ISSUER = "https://myapp.com";

  const { isAuthConfigured } = await import("../lib/auth.js");
  assert.equal(isAuthConfigured(), true);
  process.env = original;
  _resetForTesting();
});

// --- isSSOConfigured ---

test("isSSOConfigured returns false when neither OIDC nor SAML configured", async () => {
  const original = { ...process.env };
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.SAML_ENTRY_POINT;
  delete process.env.SAML_ISSUER;
  const { isSSOConfigured } = await import("../lib/sso.js");
  assert.equal(isSSOConfigured(), false);
  process.env = original;
});

test("isSSOConfigured returns true when OIDC configured", async () => {
  const original = { ...process.env };
  process.env.OIDC_ISSUER = "https://example.com";
  process.env.OIDC_CLIENT_ID = "id";
  process.env.OIDC_CLIENT_SECRET = "sec";
  const { isSSOConfigured } = await import("../lib/sso.js");
  assert.equal(isSSOConfigured(), true);
  process.env = original;
});
