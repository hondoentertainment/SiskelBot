/**
 * Advice companion morning brief — resurfaces due thoughts and formats a digest.
 * Optionally ensures a daily scheduled agent exists for the workspace.
 */
import {
  resurfaceThoughts,
  formatThoughtsHint,
  getAdviceModeStatus,
  listThoughts,
} from "./advice-companion.js";
import {
  createScheduledAgent,
  listScheduledAgents,
} from "./scheduled-agents.js";
import { resolveStorageUserId } from "./teams.js";

export const MORNING_BRIEF_AGENT_NAME = "Advice morning brief";
export const DEFAULT_MORNING_BRIEF_CRON = process.env.ADVICE_BRIEF_CRON || "0 8 * * *";

/**
 * Build a morning-brief payload for a user/workspace.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ storageUserId?: string }} [opts]
 */
export async function buildMorningBrief(userId, workspaceId, opts = {}) {
  const storageUserId = opts.storageUserId || (await resolveStorageUserId(userId, workspaceId));
  const status = await getAdviceModeStatus(storageUserId, workspaceId);
  const { thoughts, dueCount } = await resurfaceThoughts(userId, workspaceId, { limit: 12 });
  const { thoughts: all } = await listThoughts(userId, workspaceId, { limit: 5 });
  const hint = formatThoughtsHint(thoughts);
  const lines = [
    `Morning brief for workspace "${workspaceId}"`,
    `Advice mode: ${status.enabled ? "on" : "off"}${status.challenge ? " (challenge)" : ""}`,
    `Due / sticky thoughts: ${dueCount} due, ${thoughts.length} resurfaced`,
    "",
  ];
  if (thoughts.length) {
    lines.push("Focus today:");
    for (const t of thoughts.slice(0, 8)) {
      const kind = t.metadata?.thoughtKind || "note";
      lines.push(`- [${kind}] ${t.content}`);
    }
  } else {
    lines.push("No due thoughts. Capture something you want honest advice on.");
  }
  if (all.length && thoughts.length === 0) {
    lines.push("", "Recent journal:");
    for (const t of all.slice(0, 3)) {
      lines.push(`- ${t.content}`);
    }
  }
  const text = lines.join("\n");
  return {
    text,
    hint,
    adviceMode: status.enabled,
    challenge: status.challenge,
    thoughtCount: thoughts.length,
    dueCount,
    promptForAgent:
      `You are the user's honest advice companion. Deliver this morning brief warmly but directly.\n\n${text}\n\n` +
      `Ask one clarifying question if helpful, then give one concrete recommendation for the day.`,
  };
}

/**
 * Ensure a daily morning-brief scheduled agent exists for the workspace.
 * @param {string} workspaceId
 * @param {{ cron?: string, userId?: string }} [opts]
 */
export async function ensureMorningBriefSchedule(workspaceId, opts = {}) {
  const agents = await listScheduledAgents(workspaceId);
  const existing = agents.find((a) => a.name === MORNING_BRIEF_AGENT_NAME);
  if (existing) return { created: false, agent: existing };

  const brief = await buildMorningBrief(opts.userId || "anonymous", workspaceId);
  const agent = await createScheduledAgent({
    workspaceId,
    name: MORNING_BRIEF_AGENT_NAME,
    description: "Daily honest-advice brief from journal thoughts",
    cron: opts.cron || DEFAULT_MORNING_BRIEF_CRON,
    prompt: brief.promptForAgent,
    agentMode: "single",
  });
  return { created: true, agent };
}
