/**
 * Phase 34.1: Plugin publisher registry.
 *
 * Stores publisher identities (name, email, public key, contact URL) used by
 * the certification workflow to attribute plugins to verified parties.
 * Persisted to data/plugin-publishers.json.
 */
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

const VALID_VERIFY_METHODS = new Set(["email", "dns", "manual"]);

function publishersPath() {
  return join(getDataDir(), "plugin-publishers.json");
}

function defaultPublishers() {
  return { _version: 1, byId: {} };
}

async function readPublishers() {
  const raw = await readJsonPath(publishersPath(), defaultPublishers());
  if (!raw || typeof raw !== "object") return defaultPublishers();
  const byId = raw.byId && typeof raw.byId === "object" ? raw.byId : {};
  return { _version: 1, byId };
}

function isValidId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(id.trim());
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isPEM(value) {
  return typeof value === "string" && /-----BEGIN [A-Z ]+-----/.test(value);
}

/**
 * Register a publisher. Idempotent per id: re-registering updates the entry
 * but preserves the verified flag if already verified.
 *
 * @param {object} config - { id, name, email, publicKeyPEM, verifiedDomains?, contactUrl? }
 * @returns {Promise<{ok:boolean, publisher?:object, error?:string, code?:string}>}
 */
export async function registerPublisher(config) {
  if (!config || typeof config !== "object") {
    return { ok: false, code: "INVALID_INPUT", error: "config must be an object" };
  }
  const id = String(config.id || "").trim();
  if (!isValidId(id)) {
    return { ok: false, code: "INVALID_ID", error: "id must match ^[a-z0-9][a-z0-9._-]{1,127}$" };
  }
  const name = String(config.name || "").trim();
  if (!name) {
    return { ok: false, code: "INVALID_NAME", error: "name is required" };
  }
  const email = String(config.email || "").trim();
  if (!isValidEmail(email)) {
    return { ok: false, code: "INVALID_EMAIL", error: "email must be a valid address" };
  }
  const publicKeyPEM = String(config.publicKeyPEM || "").trim();
  if (!isPEM(publicKeyPEM)) {
    return { ok: false, code: "INVALID_PUBLIC_KEY", error: "publicKeyPEM must be a PEM-encoded key" };
  }
  const verifiedDomains = Array.isArray(config.verifiedDomains)
    ? config.verifiedDomains
        .map((d) => String(d || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const contactUrl = typeof config.contactUrl === "string" ? config.contactUrl.trim() : "";

  return withPathLock(publishersPath(), async () => {
    const data = await readPublishers();
    const prev = data.byId[id] || null;
    const publisher = {
      id,
      name,
      email,
      publicKeyPEM,
      verifiedDomains,
      contactUrl,
      verified: prev && prev.verified ? true : false,
      verifiedAt: prev && prev.verifiedAt ? prev.verifiedAt : null,
      verificationMethod: prev && prev.verificationMethod ? prev.verificationMethod : null,
      registeredAt: prev && prev.registeredAt ? prev.registeredAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.byId[id] = publisher;
    await writeJsonPath(publishersPath(), data);
    return { ok: true, publisher };
  });
}

/**
 * Mark a publisher as verified via the given method.
 *
 * @param {string} id
 * @param {"email"|"dns"|"manual"} verificationMethod
 * @returns {Promise<{ok:boolean, publisher?:object, error?:string, code?:string}>}
 */
export async function verifyPublisher(id, verificationMethod) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) {
    return { ok: false, code: "INVALID_INPUT", error: "id is required" };
  }
  if (!VALID_VERIFY_METHODS.has(verificationMethod)) {
    return {
      ok: false,
      code: "INVALID_METHOD",
      error: `verificationMethod must be one of: ${[...VALID_VERIFY_METHODS].join(", ")}`,
    };
  }
  return withPathLock(publishersPath(), async () => {
    const data = await readPublishers();
    const publisher = data.byId[normalizedId];
    if (!publisher) {
      return { ok: false, code: "NOT_FOUND", error: "publisher not found" };
    }
    publisher.verified = true;
    publisher.verifiedAt = new Date().toISOString();
    publisher.verificationMethod = verificationMethod;
    publisher.updatedAt = publisher.verifiedAt;
    data.byId[normalizedId] = publisher;
    await writeJsonPath(publishersPath(), data);
    return { ok: true, publisher };
  });
}

export async function getPublisher(id) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;
  const data = await readPublishers();
  return data.byId[normalizedId] || null;
}

export async function listPublishers(verifiedOnly = false) {
  const data = await readPublishers();
  const all = Object.values(data.byId || {});
  if (verifiedOnly) return all.filter((p) => p && p.verified);
  return all;
}
