/**
 * Minimal SAML 2.0 Service Provider implementation.
 * No heavy dependencies — uses Node.js crypto for signature validation
 * and basic XML string building/parsing.
 *
 * Env vars:
 *   SAML_ENTRY_POINT   — IdP SSO URL
 *   SAML_ISSUER         — SP entity ID
 *   SAML_CERT           — IdP certificate (PEM, base64 block only — no headers)
 *   SAML_CALLBACK_URL   — SP ACS URL (e.g. https://myapp.com/auth/saml/callback)
 *
 * Phase 46.3: After successful authentication the parsed assertion is fed to
 * provisionUserFromSSO to JIT-create or update the user.
 */
import { createVerify, randomUUID } from "crypto";
import { Strategy as CustomStrategy } from "passport-strategy";
import { provisionUserFromSSO, mapSSOClaimsToUser } from "./jit-provisioning.js";

/**
 * Parse and validate SAML configuration from env or explicit options.
 * @param {Record<string,string>} [opts]
 * @returns {{ entryPoint: string, issuer: string, cert: string, callbackUrl: string } | null}
 */
export function configureSAML(opts = {}) {
  const entryPoint = opts.entryPoint || process.env.SAML_ENTRY_POINT;
  const issuer = opts.issuer || process.env.SAML_ISSUER;
  const cert = opts.cert || process.env.SAML_CERT;
  const callbackUrl = opts.callbackUrl || process.env.SAML_CALLBACK_URL;

  if (!entryPoint || !issuer) return null;

  return { entryPoint, issuer, cert: cert || "", callbackUrl: callbackUrl || "/auth/saml/callback" };
}

/**
 * Check if SAML is configured via env vars.
 */
export function isSAMLConfigured() {
  return Boolean(process.env.SAML_ENTRY_POINT && process.env.SAML_ISSUER);
}

/**
 * Map SAML assertion attributes to internal user model.
 * SAML attributes use various URIs; we look for common ones.
 * @param {Record<string,string>} attrs — flattened SAML attributes
 * @returns {{ id: string, displayName: string, email: string|null, provider: 'saml' }}
 */
export function mapSAMLAttributesToUser(attrs) {
  if (!attrs) throw new Error("SAML attributes missing");

  // Common SAML attribute names / URIs
  const id =
    attrs.nameID ||
    attrs["urn:oid:0.9.2342.19200300.100.1.1"] || // uid
    attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] ||
    attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
    attrs.uid ||
    attrs.sub;
  if (!id) throw new Error("SAML: no user identifier found in attributes");

  const displayName =
    attrs.displayName ||
    attrs["urn:oid:2.16.840.1.113730.3.1.241"] || // displayName OID
    attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
    attrs.cn ||
    attrs.commonName ||
    String(id);

  const email =
    attrs.email ||
    attrs.mail ||
    attrs["urn:oid:0.9.2342.19200300.100.1.3"] || // mail OID
    attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ||
    null;

  return {
    id: String(id),
    displayName: String(displayName),
    email: email ? String(email) : null,
    provider: "saml",
  };
}

/**
 * Build a SAML AuthnRequest XML string.
 * @param {{ issuer: string, callbackUrl: string, id?: string }} opts
 * @returns {string}
 */
export function buildAuthnRequest({ issuer, callbackUrl, id }) {
  const requestId = id || `_${randomUUID().replace(/-/g, "")}`;
  const issueInstant = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
    `  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    `  ID="${requestId}"`,
    `  Version="2.0"`,
    `  IssueInstant="${issueInstant}"`,
    `  AssertionConsumerServiceURL="${escapeXml(callbackUrl)}"`,
    `  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">`,
    `  <saml:Issuer>${escapeXml(issuer)}</saml:Issuer>`,
    `</samlp:AuthnRequest>`,
  ].join("\n");
}

/**
 * Build the redirect URL for SAML SSO (HTTP-Redirect binding).
 * @param {{ entryPoint: string, issuer: string, callbackUrl: string }} config
 * @returns {string}
 */
export function buildRedirectUrl(config) {
  const authnRequest = buildAuthnRequest({ issuer: config.issuer, callbackUrl: config.callbackUrl });
  const deflated = Buffer.from(authnRequest, "utf8");
  const encoded = deflated.toString("base64");
  const url = new URL(config.entryPoint);
  url.searchParams.set("SAMLRequest", encoded);
  return url.toString();
}

/**
 * Parse a SAML Response XML and extract NameID and attributes.
 * This is a minimal parser — not a full SAML library. Handles common cases.
 * @param {string} xml
 * @returns {{ nameID: string, attributes: Record<string,string> }}
 */
export function parseSAMLResponse(xml) {
  if (!xml || typeof xml !== "string") throw new Error("SAML response is empty or not a string");

  // Extract NameID
  const nameIDMatch = xml.match(/<(?:saml2?:)?NameID[^>]*>([^<]+)<\/(?:saml2?:)?NameID>/);
  const nameID = nameIDMatch ? nameIDMatch[1].trim() : null;

  // Extract Attribute values
  const attributes = {};
  if (nameID) attributes.nameID = nameID;

  // Match <Attribute Name="..."><AttributeValue>...</AttributeValue></Attribute>
  const attrRegex = /<(?:saml2?:)?Attribute\s+Name="([^"]+)"[^>]*>\s*<(?:saml2?:)?AttributeValue[^>]*>([^<]*)<\/(?:saml2?:)?AttributeValue>/g;
  let m;
  while ((m = attrRegex.exec(xml)) !== null) {
    attributes[m[1]] = m[2].trim();
  }

  return { nameID, attributes };
}

/**
 * Verify the XML signature of a SAML Response using the IdP certificate.
 * @param {string} xml — the full SAML Response XML
 * @param {string} certPem — PEM certificate (base64 block, no headers)
 * @returns {boolean}
 */
export function verifySignature(xml, certPem) {
  if (!certPem) return false;

  // Extract SignatureValue and SignedInfo
  const sigValueMatch = xml.match(/<(?:ds:)?SignatureValue[^>]*>([^<]+)<\/(?:ds:)?SignatureValue>/);
  const signedInfoMatch = xml.match(/<(?:ds:)?SignedInfo[^>]*>([\s\S]*?)<\/(?:ds:)?SignedInfo>/);
  if (!sigValueMatch || !signedInfoMatch) return false;

  const signatureValue = Buffer.from(sigValueMatch[1].replace(/\s+/g, ""), "base64");
  // Reconstruct the SignedInfo element with canonical namespace
  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfoMatch[1]}</ds:SignedInfo>`;

  // Detect algorithm from SignatureMethod
  const algMatch = xml.match(/<(?:ds:)?SignatureMethod\s+Algorithm="([^"]+)"/);
  let algorithm = "RSA-SHA256";
  if (algMatch) {
    const alg = algMatch[1].toLowerCase();
    if (alg.includes("sha1")) algorithm = "RSA-SHA1";
    else if (alg.includes("sha512")) algorithm = "RSA-SHA512";
  }

  const pem = certPem.includes("BEGIN CERTIFICATE")
    ? certPem
    : `-----BEGIN CERTIFICATE-----\n${certPem}\n-----END CERTIFICATE-----`;

  try {
    const verifier = createVerify(algorithm);
    verifier.update(signedInfoXml);
    return verifier.verify(pem, signatureValue);
  } catch {
    return false;
  }
}

/**
 * Generate SP metadata XML.
 * @param {{ issuer: string, callbackUrl: string }} config
 * @returns {string}
 */
export function generateMetadata({ issuer, callbackUrl }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(issuer)}">`,
    `  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">`,
    `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(callbackUrl)}" index="0" isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join("\n");
}

/**
 * Create a Passport-compatible strategy for SAML.
 * @param {ReturnType<typeof configureSAML>} config
 * @returns {CustomStrategy}
 */
export function createSAMLStrategy(config) {
  if (!config) throw new Error("SAML config required");

  const strategy = new CustomStrategy();
  strategy.name = "saml";

  strategy.authenticate = function (req) {
    try {
      // POST callback with SAMLResponse
      const samlResponse = req.body?.SAMLResponse;
      if (samlResponse) {
        const xml = Buffer.from(samlResponse, "base64").toString("utf8");

        // Verify signature if cert provided
        if (config.cert) {
          const valid = verifySignature(xml, config.cert);
          if (!valid) {
            return this.fail({ message: "SAML signature validation failed" }, 401);
          }
        }

        const { nameID, attributes } = parseSAMLResponse(xml);
        if (!nameID && Object.keys(attributes).length === 0) {
          return this.fail({ message: "SAML response contained no user information" }, 401);
        }

        const user = mapSAMLAttributesToUser(attributes);

        // JIT provisioning (best effort — failures must not block SSO).
        const self = this;
        void (async () => {
          try {
            // SAML "groups" attribute can come in many shapes; collect any group claims.
            const groupsRaw =
              attributes.groups ||
              attributes.Group ||
              attributes["http://schemas.xmlsoap.org/claims/Group"] ||
              null;
            const normalized = await mapSSOClaimsToUser(
              {
                sub: user.id,
                email: user.email,
                name: user.displayName,
                groups: groupsRaw,
              },
              { provider: "saml" }
            );
            if (normalized.email || normalized.userId) {
              await provisionUserFromSSO(normalized, { defaultWorkspace: "default" });
            }
          } catch (_) {
            // Swallow JIT errors — auth still succeeds.
          }
          return self.success(user);
        })();
        return;
      }

      // Initial request — redirect to IdP
      const redirectUrl = buildRedirectUrl(config);
      return this.redirect(redirectUrl);
    } catch (err) {
      return this.error(err);
    }
  };

  return strategy;
}

/** Escape XML special characters. */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
