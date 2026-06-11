/**
 * Phase 24: Monetization & Multi-Tenancy — Plan management.
 * Defines subscription plans with token limits, workspace caps, member caps,
 * and feature gates. Persists workspace-to-plan mappings via json-path-store.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const PLANS = {
  free: {
    name: "Free",
    tokensPerMonth: 100_000,
    maxWorkspaces: 2,
    maxMembers: 3,
    features: ["chat", "knowledge"],
    priceMonthly: 0,
  },
  pro: {
    name: "Pro",
    tokensPerMonth: 1_000_000,
    maxWorkspaces: 10,
    maxMembers: 20,
    features: ["chat", "knowledge", "agent", "swarm", "workflows", "integrations"],
    priceMonthly: 29,
  },
  enterprise: {
    name: "Enterprise",
    tokensPerMonth: Infinity,
    maxWorkspaces: Infinity,
    maxMembers: Infinity,
    features: ["*"],
    priceMonthly: 299,
  },
};

function plansPath() {
  return join(getDataDir(), "workspace-plans.json");
}

/** Stripe webhook snapshot stored by lib/billing.js (must stay path-aligned). */
function stripeSubscriptionSnapPath(workspaceId) {
  return join(getDataDir(), "billing-subscriptions", `${String(workspaceId || "default")}.json`);
}

async function loadPlanMappings() {
  const data = await readJsonPath(plansPath(), { _version: 1, mappings: {} });
  return data.mappings && typeof data.mappings === "object" ? data.mappings : {};
}

/**
 * List all available plans.
 * @returns {Array<{ id: string, name: string, tokensPerMonth: number, maxWorkspaces: number, maxMembers: number, features: string[], priceMonthly: number }>}
 */
export function listPlans() {
  return Object.entries(PLANS).map(([id, plan]) => ({ id, ...plan }));
}

/**
 * Get the plan definition by plan ID.
 * @param {string} planId
 * @returns {{ id: string, name: string, tokensPerMonth: number, maxWorkspaces: number, maxMembers: number, features: string[], priceMonthly: number } | null}
 */
export function getPlanDefinition(planId) {
  const plan = PLANS[planId];
  if (!plan) return null;
  return { id: planId, ...plan };
}

/**
 * Get the plan assigned to a workspace (defaults to "free").
 * @param {string} workspaceId
 * @returns {Promise<{ id: string, name: string, tokensPerMonth: number, maxWorkspaces: number, maxMembers: number, features: string[], priceMonthly: number }>}
 */
export async function getPlan(workspaceId) {
  const sub = await readJsonPath(stripeSubscriptionSnapPath(workspaceId), {});
  const status = String(sub.status ?? "");
  const subPlanId = String(sub.plan || "").trim();
  const stripePaid =
    (status === "active" || status === "past_due") && Boolean(PLANS[subPlanId]);

  const mappings = await loadPlanMappings();
  const mappedId = mappings[String(workspaceId)] || "free";
  let planId = stripePaid ? subPlanId : mappedId;

  // Honor an active freemium trial when the workspace would otherwise be free
  // (never overrides a paid Stripe subscription or an explicit paid mapping).
  if (!stripePaid && (planId === "free" || !PLANS[planId])) {
    try {
      const { getActiveTrialPlan } = await import("./trials.js");
      const trialPlan = await getActiveTrialPlan(workspaceId);
      if (trialPlan && PLANS[trialPlan]) planId = trialPlan;
    } catch { /* trials optional */ }
  }

  const plan = PLANS[planId] || PLANS.free;
  return { id: planId in PLANS ? planId : "free", ...plan };
}

/**
 * Assign a plan to a workspace.
 * @param {string} workspaceId
 * @param {string} planId
 * @returns {Promise<{ ok: boolean, plan?: object, error?: string }>}
 */
export async function setPlan(workspaceId, planId) {
  if (!workspaceId || typeof workspaceId !== "string" || !workspaceId.trim()) {
    return { ok: false, error: "Workspace ID is required" };
  }
  if (!PLANS[planId]) {
    return { ok: false, error: `Unknown plan: ${planId}. Valid plans: ${Object.keys(PLANS).join(", ")}` };
  }
  const path = plansPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, mappings: {} });
    if (!data.mappings) data.mappings = {};
    data.mappings[String(workspaceId).trim()] = planId;
    await writeJsonPath(path, data);
    return { ok: true, plan: { id: planId, ...PLANS[planId] } };
  });
}

/**
 * Check if a workspace has access to a specific feature.
 * Enterprise ("*") grants access to everything.
 * @param {string} workspaceId
 * @param {string} feature
 * @returns {Promise<{ allowed: boolean, plan: string, feature: string }>}
 */
export async function checkFeatureAccess(workspaceId, feature) {
  const plan = await getPlan(workspaceId);
  const allowed = plan.features.includes("*") || plan.features.includes(feature);
  return { allowed, plan: plan.id, feature };
}
