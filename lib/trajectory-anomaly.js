/**
 * Phase 73.4: Trajectory clustering + anomaly detection via tool-call fingerprints.
 */
import { createHash } from "crypto";
import { computeFingerprint } from "./agent-stagnation.js";

/**
 * @param {{ toolCalls?: Array<{ name?: string, args?: object }>, stopReason?: string, iteration?: number }} traj
 */
export function trajectorySignature(traj = {}) {
  const calls = Array.isArray(traj.toolCalls) ? traj.toolCalls : [];
  const tools = calls.map((c) => c.name || "?").sort().join(",");
  const fp = computeFingerprint(calls.slice(0, 12));
  const raw = `${traj.stopReason || "unknown"}|${traj.iteration || 0}|${tools}|${fp}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Cluster trajectories by signature; flag singleton / rare clusters as anomalies.
 * @param {Array<object>} trajectories
 * @param {{ rareThreshold?: number }} [opts]
 */
export function clusterTrajectories(trajectories, opts = {}) {
  const rareThreshold = Math.max(1, Number(opts.rareThreshold) || 1);
  const groups = new Map();
  for (const t of trajectories || []) {
    const sig = trajectorySignature(t);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(t);
  }
  const clusters = [...groups.entries()].map(([signature, members]) => ({
    signature,
    size: members.length,
    anomaly: members.length <= rareThreshold,
    sampleStopReasons: [...new Set(members.map((m) => m.stopReason || "unknown"))].slice(0, 5),
  }));
  clusters.sort((a, b) => b.size - a.size);
  return {
    total: (trajectories || []).length,
    clusterCount: clusters.length,
    anomalies: clusters.filter((c) => c.anomaly),
    clusters,
  };
}
