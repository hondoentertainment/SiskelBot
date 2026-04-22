/**
 * Wave-2: Durable HITL audit log. Persists every HITL approval request and
 * its resolution (approve/deny/expired) so operators have a permanent,
 * compliance-grade trail of tool-call decisions.
 *
 * Complements agent-hitl-store.js, which holds the in-memory resume state
 * (15-min TTL). The audit log captures the lifecycle events only — no
 * sensitive continuation state — and is append-only.
 *
 * Off by default. Enable via AGENT_HITL_AUDIT=1.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_AUDIT_ENTRIES = 20_000;

export function hitlAuditEnabled() {
  return process.env.AGENT_HITL_AUDIT === "1";
}

function auditPath() {
  return join(getDataDir(), "hitl-audit.json");
}

async function loadAudit() {
  const raw = await readJsonPath(auditPath(), { _version: 1, entries: [] });
  return Array.isArray(raw.entries) ? raw.entries : [];
}

async function saveAudit(entries) {
  const trimmed = entries.length > MAX_AUDIT_ENTRIES ? entries.slice(-MAX_AUDIT_ENTRIES) : entries;
  await writeJsonPath(auditPath(), { _version: 1, entries: trimmed });
}

/**
 * Append an audit event. Best-effort: never throws.
 *
 * @param {{
 *   event: "request" | "approve" | "deny" | "expired",
 *   token: string,
 *   userId?: string,
 *   workspaceId?: string,
 *   sessionId?: string,
 *   toolName?: string,
 *   summary?: string,
 *   approvalId?: string,
 * }} entry
 */
export async function recordHitlEvent(entry) {
  if (!hitlAuditEnabled()) return false;
  if (!entry || typeof entry.event !== "string") return false;
  try {
    const path = auditPath();
    await withPathLock(path, async () => {
      const entries = await loadAudit();
      entries.push({
        t: Date.now(),
        event: entry.event,
        token: String(entry.token || "").slice(0, 64),
        userId: entry.userId ? String(entry.userId).slice(0, 120) : null,
        workspaceId: entry.workspaceId ? String(entry.workspaceId).slice(0, 120) : null,
        sessionId: entry.sessionId ? String(entry.sessionId).slice(0, 120) : null,
        toolName: entry.toolName ? String(entry.toolName).slice(0, 120) : null,
        summary: entry.summary ? String(entry.summary).slice(0, 500) : null,
        approvalId: entry.approvalId ? String(entry.approvalId).slice(0, 64) : null,
      });
      await saveAudit(entries);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read recent audit entries, optionally filtered by workspace.
 *
 * @param {{ workspaceId?: string, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listHitlAudit(opts = {}) {
  try {
    const entries = await loadAudit();
    const filtered = opts.workspaceId
      ? entries.filter((e) => e.workspaceId === opts.workspaceId)
      : entries;
    const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 200));
    return filtered.slice(-limit).reverse();
  } catch {
    return [];
  }
}
