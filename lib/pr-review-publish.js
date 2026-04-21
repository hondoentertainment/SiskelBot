/**
 * Phase 63.2 publish gate.
 *
 * `pr-review-agent` produces reviews; this module gates **any** outward
 * publication of those reviews behind a HITL approval token. The default
 * for the Phase 63 vertical is draft-only — callers that want to post
 * comments to GitHub (or any other system) MUST go through:
 *
 *   1. requestPublication(reviewId, workspaceId, target) → returns token
 *   2. operator approves via /api/pr-review/publish/approve with token
 *   3. consumePublication(token) → returns the comment payload to post
 *
 * The actual GitHub call is intentionally NOT in this module. Keeping
 * the network call out makes the gate auditable: the only place a review
 * can leave SiskelBot is the caller that consumes the token.
 */
import { saveHitlState, peekHitlState, takeHitlState } from "./agent-hitl-store.js";
import { getReview } from "./pr-review-agent.js";

export const SUPPORTED_TARGETS = Object.freeze(["github-pr-comments", "draft-only"]);

const APPROVAL_TTL_MS = 60 * 60 * 1000;

function isAllowedTarget(target) {
  return SUPPORTED_TARGETS.includes(target);
}

/**
 * Stage a review for publication. Returns a HITL token; nothing is sent
 * anywhere until an operator approves and a caller consumes the token.
 *
 * @param {Object} input
 * @param {string} input.reviewId
 * @param {string} input.workspaceId
 * @param {string} input.target - One of SUPPORTED_TARGETS
 * @param {string} [input.requestedBy]
 * @returns {Promise<{ token: string, expiresAt: number, target: string, commentCount: number }>}
 */
export async function requestPublication(input = {}) {
  const reviewId = String(input.reviewId || "").trim();
  const workspaceId = String(input.workspaceId || "").trim();
  const target = String(input.target || "draft-only").trim();
  if (!reviewId) throw new Error("reviewId required");
  if (!workspaceId) throw new Error("workspaceId required");
  if (!isAllowedTarget(target)) {
    throw new Error(`unsupported target: ${target}`);
  }
  const review = await getReview(reviewId, workspaceId);
  if (!review) throw new Error("review not found");
  const comments = Array.isArray(review.comments) ? review.comments : [];

  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  const token = saveHitlState(
    {
      kind: "pr-review-publication",
      reviewId,
      workspaceId,
      target,
      requestedBy: input.requestedBy || null,
      comments,
      stagedAt: Date.now(),
    },
    APPROVAL_TTL_MS
  );
  return { token, expiresAt, target, commentCount: comments.length };
}

/**
 * Inspect a pending publication without consuming it. Useful for the
 * operator UI before approval.
 */
export function inspectPublication(token) {
  const st = peekHitlState(token);
  if (!st || st.kind !== "pr-review-publication") return null;
  return {
    reviewId: st.reviewId,
    workspaceId: st.workspaceId,
    target: st.target,
    requestedBy: st.requestedBy,
    commentCount: Array.isArray(st.comments) ? st.comments.length : 0,
    stagedAt: st.stagedAt,
  };
}

/**
 * Approve and consume a publication token. Returns the comment payload
 * for the caller to send. After this call the token is gone.
 *
 * @param {string} token
 * @param {{ decision?: "approve" | "deny" }} [opts]
 */
export function consumePublication(token, opts = {}) {
  const decision = opts.decision === "deny" ? "deny" : "approve";
  const st = takeHitlState(token, { decision });
  if (!st || st.kind !== "pr-review-publication") return null;
  if (decision === "deny") {
    return { decision, target: st.target, comments: [] };
  }
  return {
    decision,
    target: st.target,
    reviewId: st.reviewId,
    workspaceId: st.workspaceId,
    comments: Array.isArray(st.comments) ? st.comments : [],
  };
}
