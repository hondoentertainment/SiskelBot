/**
 * Freemium trials — let a workspace try a higher plan for a limited window,
 * then revert to free. Drives self-serve conversion (the funnel from free to
 * paid). One trial per workspace.
 *
 * Storage: data/trials/{workspaceId}.json
 *
 * Trials are honored by lib/plans.js#getPlan: when a workspace would otherwise
 * resolve to "free" (no active paid Stripe subscription), an active trial
 * upgrades its effective plan everywhere limits/features are checked.
 *
 * Config:
 *   TRIAL_DEFAULT_PLAN  plan granted by a trial (default "pro")
 *   TRIAL_DEFAULT_DAYS  trial length in days (default 14)
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getPlanDefinition } from "./plans.js";

const DEFAULT_PLAN = process.env.TRIAL_DEFAULT_PLAN || "pro";
const DEFAULT_DAYS = Math.max(1, Number(process.env.TRIAL_DEFAULT_DAYS) || 14);
const MAX_DAYS = 90;

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function storePath(workspaceId) {
  return join(getDataDir(), "trials", sanitizeWorkspace(workspaceId) + ".json");
}

function computeStatus(trial) {
  if (!trial || !trial.endsAt) return null;
  const ends = Date.parse(trial.endsAt);
  const active = trial.status === "active" && Number.isFinite(ends) && Date.now() < ends;
  const daysRemaining = active ? Math.ceil((ends - Date.now()) / 86_400_000) : 0;
  return {
    workspaceId: trial.workspaceId,
    plan: trial.plan,
    startedAt: trial.startedAt,
    endsAt: trial.endsAt,
    active,
    expired: !active && trial.status === "active" && Number.isFinite(ends) && Date.now() >= ends,
    daysRemaining,
  };
}

/**
 * Start a trial for a workspace. One trial per workspace — returns an error if
 * one was already started.
 * @param {string} workspaceId
 * @param {{ plan?: string, days?: number }} [opts]
 */
export async function startTrial(workspaceId, opts = {}) {
  const ws = sanitizeWorkspace(workspaceId);
  const plan = opts.plan || DEFAULT_PLAN;
  if (!getPlanDefinition(plan)) {
    return { ok: false, error: `Unknown plan: ${plan}` };
  }
  const days = Math.min(MAX_DAYS, Math.max(1, Number(opts.days) || DEFAULT_DAYS));
  const path = storePath(ws);

  return withPathLock(path, async () => {
    const existing = await readJsonPath(path, null);
    if (existing && existing.startedAt) {
      return { ok: false, error: "A trial has already been used for this workspace", trial: computeStatus(existing) };
    }
    const now = new Date();
    const endsAt = new Date(now.getTime() + days * 86_400_000);
    const trial = {
      workspaceId: ws,
      plan,
      status: "active",
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    await writeJsonPath(path, trial);
    return { ok: true, trial: computeStatus(trial) };
  });
}

/**
 * Get trial status for a workspace (null if none).
 * @param {string} workspaceId
 */
export async function getTrial(workspaceId) {
  const trial = await readJsonPath(storePath(workspaceId), null);
  return computeStatus(trial);
}

/**
 * The plan id granted by an *active* trial, or null. Used by plans.getPlan.
 * @param {string} workspaceId
 */
export async function getActiveTrialPlan(workspaceId) {
  const status = await getTrial(workspaceId);
  return status && status.active ? status.plan : null;
}

/**
 * End a trial early (e.g., on conversion to a paid plan or cancellation).
 * @param {string} workspaceId
 */
export async function endTrial(workspaceId) {
  const path = storePath(workspaceId);
  let ended = false;
  await withPathLock(path, async () => {
    const trial = await readJsonPath(path, null);
    if (trial && trial.status === "active") {
      trial.status = "ended";
      trial.endedAt = new Date().toISOString();
      await writeJsonPath(path, trial);
      ended = true;
    }
  });
  return ended;
}
