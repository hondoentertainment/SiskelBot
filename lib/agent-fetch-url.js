/**
 * Phase 85: Allowlisted HTTP fetch for agents (SSRF-safe). Uses AGENT_FETCH_ALLOWLIST
 * or falls back to KNOWLEDGE_URL_ALLOWLIST entries.
 */
import { isUrlAllowedForKnowledge, fetchTextFromUrlWithEntries } from "./knowledge-url-fetch.js";

function parseAgentAllowlist() {
  const raw = process.env.AGENT_FETCH_ALLOWLIST?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const fallback = process.env.KNOWLEDGE_URL_ALLOWLIST?.trim() || "";
  return fallback
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {Promise<{ text: string, finalUrl?: string } | { error: string, code: string }>}
 */
export async function agentFetchAllowedUrl(urlString) {
  const entries = parseAgentAllowlist();
  if (!entries.length) {
    return { error: "Set AGENT_FETCH_ALLOWLIST or KNOWLEDGE_URL_ALLOWLIST", code: "ALLOWLIST_REQUIRED" };
  }
  if (!isUrlAllowedForKnowledge(urlString.trim(), entries)) {
    return { error: "URL not allowlisted for agent fetch", code: "URL_NOT_ALLOWED" };
  }
  const maxBytes = Math.min(2 * 1024 * 1024, Number(process.env.AGENT_FETCH_MAX_BYTES) || 262_144);
  const timeoutMs = Number(process.env.AGENT_FETCH_TIMEOUT_MS) || 12_000;
  return fetchTextFromUrlWithEntries(urlString.trim(), entries, { maxBytes, timeoutMs });
}
