/**
 * Phase 37.4: Client WebAuthn / Passkey helper.
 *
 * Wraps navigator.credentials.create() and navigator.credentials.get() so
 * the UI can call registerPasskey() / authenticateWithPasskey() without
 * having to deal with ArrayBuffer <-> base64url encoding.
 */

function base64urlToBuffer(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || err.message || `request failed: ${res.status}`);
  }
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || err.message || `request failed: ${res.status}`);
  }
  return res.json();
}

async function deleteRequest(url) {
  const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || err.message || `request failed: ${res.status}`);
  }
  return true;
}

/**
 * Register a new passkey for the given user name.
 * @param {string} userName
 * @param {string} [displayName]
 * @returns {Promise<{ ok: boolean, credentialId: string }>}
 */
export async function registerPasskey(userName, displayName) {
  if (!isWebAuthnSupported()) throw new Error('WebAuthn is not supported in this browser');

  const options = await postJson('/api/v1/auth/webauthn/register/options', { userName, displayName });

  const publicKey = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64urlToBuffer(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  };

  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw new Error('credential creation cancelled');

  const payload = {
    credential: {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
        attestationObject: cred.response.attestationObject
          ? bufferToBase64url(cred.response.attestationObject)
          : undefined,
        transports: typeof cred.response.getTransports === 'function'
          ? cred.response.getTransports()
          : [],
      },
    },
  };

  // If the browser exposes a raw authenticatorData (rare), include it —
  // otherwise the server parses attestationObject on its own when able.
  if (cred.response.authenticatorData) {
    payload.authenticatorData = bufferToBase64url(cred.response.authenticatorData);
  }

  return postJson('/api/v1/auth/webauthn/register/verify', payload);
}

/**
 * Authenticate using an existing passkey.
 * @param {string} [userName] - Optional: scopes the challenge to a user.
 * @returns {Promise<{ ok: boolean, userId: string }>}
 */
export async function authenticateWithPasskey(userName) {
  if (!isWebAuthnSupported()) throw new Error('WebAuthn is not supported in this browser');

  const options = await postJson('/api/v1/auth/webauthn/authenticate/options', { userId: userName });

  const publicKey = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  };

  const cred = await navigator.credentials.get({ publicKey });
  if (!cred) throw new Error('authentication cancelled');

  const payload = {
    credential: {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
        authenticatorData: bufferToBase64url(cred.response.authenticatorData),
        signature: bufferToBase64url(cred.response.signature),
        userHandle: cred.response.userHandle
          ? bufferToBase64url(cred.response.userHandle)
          : null,
      },
    },
  };

  return postJson('/api/v1/auth/webauthn/authenticate/verify', payload);
}

/** List passkeys registered for the current user. */
export async function listPasskeys() {
  const data = await getJson('/api/v1/auth/webauthn/credentials');
  return data.credentials || [];
}

/** Delete a passkey by credentialId. */
export async function deletePasskey(credentialId) {
  return deleteRequest(`/api/v1/auth/webauthn/credentials/${encodeURIComponent(credentialId)}`);
}

/** Feature detection: does this browser support WebAuthn? */
export function isWebAuthnSupported() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && window.PublicKeyCredential != null;
}

/** Feature detection: is a platform authenticator (Face ID / Touch ID / Windows Hello) available? */
export async function isPlatformAuthenticatorAvailable() {
  if (!isWebAuthnSupported()) return false;
  if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    return false;
  }
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// Expose on window for non-module consumers (inline scripts in index.html).
if (typeof window !== 'undefined') {
  window.SiskelWebAuthn = {
    registerPasskey,
    authenticateWithPasskey,
    listPasskeys,
    deletePasskey,
    isWebAuthnSupported,
    isPlatformAuthenticatorAvailable,
  };
}
