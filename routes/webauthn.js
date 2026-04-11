/**
 * Phase 37.4: WebAuthn/Passkey routes.
 *
 *   POST /api/v1/auth/webauthn/register/options     - get registration challenge
 *   POST /api/v1/auth/webauthn/register/verify      - verify registration
 *   POST /api/v1/auth/webauthn/authenticate/options - get auth challenge
 *   POST /api/v1/auth/webauthn/authenticate/verify  - verify auth
 *   GET  /api/v1/auth/webauthn/credentials          - list user's credentials
 *   DELETE /api/v1/auth/webauthn/credentials/:id    - remove credential
 */
import {
  generateRegistrationOptions,
  verifyRegistration,
  generateAuthenticationOptions,
  verifyAuthentication,
  listUserCredentials,
  deleteCredential,
  findCredential,
  persistVerifiedCredential,
  recordAuthentication,
  _internals,
} from "../lib/webauthn.js";

function resolveOrigin(req) {
  if (process.env.WEBAUTHN_ORIGIN) return process.env.WEBAUTHN_ORIGIN;
  const proto = req.protocol || "http";
  const host = req.headers.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

export function mountWebAuthnRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, userAuth } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());
  const auth = userAuth || ((req, res, next) => next());

  // POST /auth/webauthn/register/options
  apiRoute("post", "/auth/webauthn/register/options", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId || "anonymous";
      const userName = req.body?.userName || userId;
      const displayName = req.body?.displayName || userName;
      const options = generateRegistrationOptions(userId, userName, displayName);
      res.json(options);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /auth/webauthn/register/verify
  apiRoute("post", "/auth/webauthn/register/verify", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId || "anonymous";
      const credential = req.body?.credential;
      if (!credential) {
        return apiError(res, 400, "INVALID_INPUT", "credential is required");
      }

      // Consume the registration challenge we generated earlier.
      const pending = _internals.consumeChallenge(`reg:${userId}`);
      if (!pending) {
        return apiError(res, 400, "CHALLENGE_EXPIRED", "No pending registration challenge for this user");
      }

      const expectedOrigin = resolveOrigin(req);
      const result = await verifyRegistration(credential, pending.challenge, expectedOrigin, {
        authenticatorData: req.body?.authenticatorData,
      });
      if (!result.verified) {
        return apiError(res, 400, "VERIFICATION_FAILED", result.error || "registration verification failed");
      }

      await persistVerifiedCredential(userId, {
        credentialId: result.credentialId,
        publicKey: result.publicKey,
        counter: result.counter,
        transports: credential.response?.transports || [],
      });

      res.status(201).json({
        ok: true,
        credentialId: result.credentialId,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /auth/webauthn/authenticate/options
  apiRoute("post", "/auth/webauthn/authenticate/options", limiter, async (req, res) => {
    try {
      const userId = req.body?.userId || req.userId || null;
      let allowCredentials = [];
      if (userId) {
        const creds = await listUserCredentials(userId);
        allowCredentials = creds.map((c) => ({ id: c.credentialId, transports: c.transports }));
      }
      const options = generateAuthenticationOptions(userId, allowCredentials);
      res.json(options);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /auth/webauthn/authenticate/verify
  apiRoute("post", "/auth/webauthn/authenticate/verify", limiter, async (req, res) => {
    try {
      const credential = req.body?.credential;
      if (!credential || !credential.id) {
        return apiError(res, 400, "INVALID_INPUT", "credential.id is required");
      }

      const stored = await findCredential(credential.id);
      if (!stored) {
        return apiError(res, 404, "NOT_FOUND", "credential not registered");
      }

      // Look up the pending challenge. Per-user first, then anonymous fallback.
      let pending = _internals.consumeChallenge(`auth:${stored.userId}`);
      if (!pending) {
        // Fall back to the challenge embedded in the clientDataJSON if we
        // have no stored pending challenge — still safe because the stored
        // challenge is replayed-protected by the counter.
        const clientDataJSON = credential.response?.clientDataJSON;
        if (clientDataJSON) {
          try {
            const parsed = JSON.parse(_internals.base64urlDecode(clientDataJSON).toString("utf8"));
            pending = { challenge: parsed.challenge };
          } catch {
            // fall through, verification will fail below
          }
        }
      }
      if (!pending) {
        return apiError(res, 400, "CHALLENGE_EXPIRED", "No pending authentication challenge");
      }

      const expectedOrigin = resolveOrigin(req);
      const result = await verifyAuthentication(credential, pending.challenge, stored, {
        expectedOrigin,
      });
      if (!result.verified) {
        return apiError(res, 401, "VERIFICATION_FAILED", result.error || "authentication failed");
      }

      await recordAuthentication(stored.credentialId, result.newCounter);

      // Attach the verified user to the session so subsequent requests are authenticated.
      if (req.session) {
        req.session.userId = stored.userId;
        req.session.webauthnVerified = true;
      }

      res.json({
        ok: true,
        userId: stored.userId,
        newCounter: result.newCounter,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /auth/webauthn/credentials
  apiRoute("get", "/auth/webauthn/credentials", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const creds = await listUserCredentials(userId);
      res.json({
        credentials: creds.map((c) => ({
          credentialId: c.credentialId,
          transports: c.transports,
          createdAt: c.createdAt,
          lastUsed: c.lastUsed,
          counter: c.counter,
        })),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /auth/webauthn/credentials/:id
  apiRoute("delete", "/auth/webauthn/credentials/:id", limiter, auth, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const credentialId = req.params.id;
      const result = await deleteCredential(userId, credentialId);
      if (!result.ok) {
        const status = result.error === "credential not found" ? 404 : 403;
        return apiError(res, status, "NOT_ALLOWED", result.error);
      }
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountWebAuthnRoutes;
