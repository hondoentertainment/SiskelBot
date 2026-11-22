/**
 * Advice-page view of initiative proposals.
 * Shows open proposals (pending and approved). Dismissed and executed stay out.
 */
import { listProposals } from "./initiative-engine.js";

export function toAdviceInbox(proposals) {
  if (!Array.isArray(proposals)) return [];
  return proposals
    .filter((p) => p && (p.status === "pending" || p.status === "approved"))
    .map((p) => ({
      id: p.id,
      title: String(p.title || "").slice(0, 200),
      rationale: String(p.rationale || "").slice(0, 500),
      category: p.category || "investigate",
      confidence: p.confidence ?? null,
      status: p.status,
      suggestedAction: String(p.suggestedAction || "").slice(0, 300),
      createdAt: p.createdAt || null,
    }));
}

export async function loadAdviceInbox(workspaceId, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 20), 50);
  const [pending, approved] = await Promise.all([
    listProposals(workspaceId, { status: "pending", limit }),
    listProposals(workspaceId, { status: "approved", limit }),
  ]);
  return toAdviceInbox([...pending, ...approved]).slice(0, limit);
}
