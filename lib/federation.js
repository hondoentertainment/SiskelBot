/**
 * Federation: connect multiple SiskelBot instances for cross-instance
 * workspace discovery and interaction.
 * Builds on the multi-region HA foundation (lib/leader-election.js, lib/region-health.js).
 */
import { join } from "path";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function getFederationSecret() {
  return process.env.FEDERATION_SECRET || "";
}
const HEALTH_TIMEOUT_MS = parseInt(process.env.FEDERATION_HEALTH_TIMEOUT_MS, 10) || 5000;
const INSTANCE_ID = process.env.INSTANCE_ID || randomUUID();
const REGION_ID = process.env.REGION_ID || "default";

/**
 * @typedef {object} FederationPeer
 * @property {string} id - Peer instance ID
 * @property {string} url - Base URL of the peer
 * @property {string} name - Human-readable name
 * @property {string} region - Geographic region
 * @property {'active'|'inactive'|'unreachable'} status
 * @property {string} lastSeen - ISO timestamp
 */

function peersPath() {
  return join(getDataDir(), "federation-peers.json");
}

function workspaceMetaPath() {
  return join(getDataDir(), "federation-workspace-meta.json");
}

// --- HMAC Signing ---

/**
 * Sign a payload with the federation shared secret.
 */
export function signPayload(payload, secret) {
  const sec = secret || getFederationSecret();
  if (!sec) throw new Error("FEDERATION_SECRET is required for federation");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHmac("sha256", sec).update(body).digest("hex");
}

/**
 * Verify HMAC signature of a payload.
 */
export function verifySignature(payload, signature, secret) {
  const sec = secret || getFederationSecret();
  if (!sec || !signature) return false;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", sec).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Federation auth middleware: verify HMAC signature on incoming requests.
 */
export function federationAuth(req, res, next) {
  const signature = req.headers["x-federation-signature"];
  if (!signature) {
    return res.status(401).json({ error: "Missing federation signature", code: "FEDERATION_AUTH_REQUIRED" });
  }
  // We verify against the raw body string
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  if (!verifySignature(body, signature, getFederationSecret())) {
    return res.status(403).json({ error: "Invalid federation signature", code: "FEDERATION_AUTH_FAILED" });
  }
  next();
}

// --- Peer Management ---

/**
 * Register a federated peer.
 */
export async function registerPeer(peerUrl, sharedSecret) {
  if (!peerUrl) throw new Error("Peer URL is required");
  const trimmedUrl = String(peerUrl).replace(/\/+$/, "");

  const path = peersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, peers: [] });
    if (!Array.isArray(data.peers)) data.peers = [];

    // Check for duplicate URL
    const existing = data.peers.find((p) => p.url === trimmedUrl);
    if (existing) {
      existing.status = "active";
      existing.lastSeen = new Date().toISOString();
      await writeJsonPath(path, data);
      return existing;
    }

    // Try to handshake with the peer
    let peerInfo = { name: trimmedUrl, region: "unknown" };
    try {
      const pingBody = JSON.stringify({ instanceId: INSTANCE_ID, region: REGION_ID, timestamp: new Date().toISOString() });
      const sig = signPayload(pingBody, sharedSecret || getFederationSecret());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const resp = await fetch(`${trimmedUrl}/api/internal/federation/ping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Federation-Signature": sig,
        },
        body: pingBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const respData = await resp.json();
        peerInfo = { name: respData.name || trimmedUrl, region: respData.region || "unknown" };
      }
    } catch {
      // Peer unreachable during registration - still register it
    }

    const peer = {
      id: randomUUID(),
      url: trimmedUrl,
      name: peerInfo.name,
      region: peerInfo.region,
      status: "active",
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    data.peers.push(peer);
    await writeJsonPath(path, data);
    return peer;
  });
}

/**
 * Remove a federated peer.
 */
export async function removePeer(peerId) {
  const path = peersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, peers: [] });
    if (!Array.isArray(data.peers)) return false;
    const idx = data.peers.findIndex((p) => p.id === peerId);
    if (idx < 0) return false;
    data.peers.splice(idx, 1);
    await writeJsonPath(path, data);
    return true;
  });
}

/**
 * List all federated peers.
 */
export async function listPeers() {
  const data = await readJsonPath(peersPath(), { _version: 1, peers: [] });
  return data.peers || [];
}

/**
 * Health check all federated peers.
 */
export async function healthCheckPeers() {
  const path = peersPath();
  const data = await readJsonPath(path, { _version: 1, peers: [] });
  if (!Array.isArray(data.peers) || data.peers.length === 0) return [];

  const checks = data.peers.map(async (peer) => {
    try {
      const pingBody = JSON.stringify({ instanceId: INSTANCE_ID, region: REGION_ID, timestamp: new Date().toISOString() });
      const sig = signPayload(pingBody);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const resp = await fetch(`${peer.url}/api/internal/federation/ping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Federation-Signature": sig,
        },
        body: pingBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      peer.status = resp.ok ? "active" : "unreachable";
      peer.lastSeen = resp.ok ? new Date().toISOString() : peer.lastSeen;
    } catch {
      peer.status = "unreachable";
    }
    return peer;
  });

  await Promise.allSettled(checks);

  // Persist updated statuses
  await withPathLock(path, async () => {
    await writeJsonPath(path, data);
  });

  return data.peers;
}

// --- Workspace Discovery ---

/**
 * Discover workspaces across federated peers.
 * Only returns workspaces marked as 'discoverable'.
 */
export async function discoverFederatedWorkspaces(query) {
  const peers = await listPeers();
  const activePeers = peers.filter((p) => p.status === "active");
  const results = [];

  // Get local discoverable workspaces
  const localMeta = await readJsonPath(workspaceMetaPath(), { _version: 1, workspaces: [] });
  const localDiscoverable = (localMeta.workspaces || []).filter((w) => w.discoverable);
  for (const ws of localDiscoverable) {
    if (!query || ws.name?.toLowerCase().includes(query.toLowerCase()) || ws.description?.toLowerCase().includes(query?.toLowerCase())) {
      results.push({ ...ws, source: "local", instanceId: INSTANCE_ID, region: REGION_ID });
    }
  }

  // Query federated peers
  const peerQueries = activePeers.map(async (peer) => {
    try {
      const body = JSON.stringify({ query: query || "", instanceId: INSTANCE_ID });
      const sig = signPayload(body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const resp = await fetch(`${peer.url}/api/internal/federation/discover`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Federation-Signature": sig,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const respData = await resp.json();
        if (Array.isArray(respData.workspaces)) {
          for (const ws of respData.workspaces) {
            results.push({ ...ws, source: "federated", peerId: peer.id, peerName: peer.name });
          }
        }
      }
    } catch {
      // Peer unavailable - skip
    }
  });

  await Promise.allSettled(peerQueries);
  return results;
}

/**
 * Forward a request to a federated peer.
 */
export async function forwardToPeer(peerId, method, path, body) {
  const peers = await listPeers();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not found`);
  if (peer.status !== "active") throw new Error(`Peer ${peerId} is ${peer.status}`);

  const bodyStr = body ? JSON.stringify(body) : "";
  const sig = signPayload(bodyStr);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS * 2);

  try {
    const resp = await fetch(`${peer.url}${path}`, {
      method: method.toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        "X-Federation-Signature": sig,
      },
      body: method.toUpperCase() !== "GET" ? bodyStr : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, data };
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`Failed to reach peer ${peerId}: ${e.message}`, { cause: e });
  }
}

/**
 * Sync workspace metadata for federation discovery.
 */
export async function syncWorkspaceMetadata(workspaceId, metadata) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const path = workspaceMetaPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, workspaces: [] });
    if (!Array.isArray(data.workspaces)) data.workspaces = [];
    const idx = data.workspaces.findIndex((w) => w.workspaceId === workspaceId);
    const entry = {
      workspaceId,
      name: metadata?.name || workspaceId,
      description: metadata?.description || "",
      discoverable: Boolean(metadata?.discoverable),
      syncedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      data.workspaces[idx] = entry;
    } else {
      data.workspaces.push(entry);
    }
    await writeJsonPath(path, data);
    return entry;
  });
}

/**
 * Handle incoming discover request from a federated peer.
 * Returns local discoverable workspaces matching query.
 */
export async function handleDiscoverRequest(query) {
  const localMeta = await readJsonPath(workspaceMetaPath(), { _version: 1, workspaces: [] });
  const discoverable = (localMeta.workspaces || []).filter((w) => w.discoverable);
  if (!query) return discoverable;
  return discoverable.filter(
    (w) =>
      w.name?.toLowerCase().includes(query.toLowerCase()) ||
      w.description?.toLowerCase().includes(query.toLowerCase()),
  );
}

/**
 * Get current instance info for ping responses.
 */
export function getInstanceInfo() {
  return {
    instanceId: INSTANCE_ID,
    region: REGION_ID,
    name: process.env.INSTANCE_NAME || `siskelbot-${REGION_ID}`,
    timestamp: new Date().toISOString(),
  };
}
