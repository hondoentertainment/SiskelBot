/**
 * Phase 25: Per-workspace IP access policies.
 * Supports exact IP matches, CIDR /8, /16, /24, and /32 notation.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { sanitizeWorkspace } from "./storage.js";

function getPolicyPath(workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  return join(getDataDir(), "ip-policy", `${ws}.json`);
}

/**
 * Parse an IPv4 address into an array of 4 numbers. Strips IPv6-mapped prefix.
 * @param {string} ip
 * @returns {number[] | null}
 */
function parseIpv4(ip) {
  const cleaned = (ip || "").replace(/^::ffff:/, "");
  const parts = cleaned.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return nums;
}

/**
 * Convert IPv4 parts to a 32-bit integer.
 * @param {number[]} parts
 * @returns {number}
 */
function ipToInt(parts) {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Check if an IP matches a CIDR or exact entry.
 * Supports /8, /16, /24, /32, and exact match.
 * @param {string} ip
 * @param {string} entry
 * @returns {boolean}
 */
function ipMatchesEntry(ip, entry) {
  const trimmed = entry.trim();
  if (!trimmed) return false;

  const [network, prefixStr] = trimmed.split("/");
  if (!prefixStr) {
    // Exact match
    const cleanIp = (ip || "").replace(/^::ffff:/, "");
    return cleanIp === network;
  }

  const prefix = Number(prefixStr);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;

  const ipParts = parseIpv4(ip);
  const netParts = parseIpv4(network);
  if (!ipParts || !netParts) return false;

  const ipInt = ipToInt(ipParts);
  const netInt = ipToInt(netParts);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

  return (ipInt & mask) === (netInt & mask);
}

/**
 * Get the IP policy for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ workspaceId: string, allowedIPs: string[], enabled: boolean }>}
 */
export async function getWorkspaceIpPolicy(workspaceId) {
  const data = await readJsonPath(getPolicyPath(workspaceId), null);
  if (!data || !data.workspaceId) {
    return {
      workspaceId: sanitizeWorkspace(workspaceId),
      allowedIPs: [],
      enabled: false,
    };
  }
  return data;
}

/**
 * Set the IP policy for a workspace.
 * @param {string} workspaceId
 * @param {string[]} allowedIPs - list of IPs or CIDRs
 * @returns {Promise<{ workspaceId: string, allowedIPs: string[], enabled: boolean }>}
 */
export async function setWorkspaceIpPolicy(workspaceId, allowedIPs) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!Array.isArray(allowedIPs)) {
    throw new Error("allowedIPs must be an array of IP addresses or CIDRs");
  }

  const sanitized = allowedIPs
    .filter((ip) => typeof ip === "string" && ip.trim())
    .map((ip) => ip.trim());

  // Validate each entry
  for (const entry of sanitized) {
    const [network, prefixStr] = entry.split("/");
    const parts = parseIpv4(network);
    if (!parts) {
      throw new Error(`Invalid IP address: ${entry}`);
    }
    if (prefixStr !== undefined) {
      const prefix = Number(prefixStr);
      if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`Invalid CIDR prefix: ${entry}`);
      }
    }
  }

  const policy = {
    workspaceId: sanitizeWorkspace(workspaceId),
    allowedIPs: sanitized,
    enabled: sanitized.length > 0,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonPath(getPolicyPath(workspaceId), policy);
  return policy;
}

/**
 * Check if a client IP is allowed access to a workspace.
 * @param {string} workspaceId
 * @param {string} clientIP
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export async function checkWorkspaceIpAccess(workspaceId, clientIP) {
  const policy = await getWorkspaceIpPolicy(workspaceId);

  if (!policy.enabled || policy.allowedIPs.length === 0) {
    return { allowed: true };
  }

  const allowed = policy.allowedIPs.some((entry) => ipMatchesEntry(clientIP, entry));

  if (!allowed) {
    return {
      allowed: false,
      reason: "IP address not in workspace allowlist",
    };
  }

  return { allowed: true };
}
