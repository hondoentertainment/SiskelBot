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
  updateScheduledAgent,
} from "./scheduled-agents.js";
import { resolveStorageUserId } from "./teams.js";
import {
  googleWorkspaceConfigured,
  gmailListMessages,
  calendarListEvents,
} from "./google-workspace-tools.js";

export const MORNING_BRIEF_AGENT_NAME = "Advice morning brief";
export const DEFAULT_MORNING_BRIEF_CRON = process.env.ADVICE_BRIEF_CRON || "0 8 * * *";

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Clock time from a Google dateTime, or the date for an all-day event. */
function clockLabel(value) {
  const raw = String(value || "");
  const match = raw.match(/T(\d{2}:\d{2})/);
  if (match) return match[1];
  return raw.slice(0, 10);
}

/**
 * Today's calendar and recent unread mail. Stays journal-only when Google
 * Workspace is not connected. Callers may inject list functions in tests.
 * @param {{ now?: Date, calendarListEvents?: Function, gmailListMessages?: Function }} [opts]
 */
export async function loadOperatorContext(opts = {}) {
  const listEvents = opts.calendarListEvents || calendarListEvents;
  const listMessages = opts.gmailListMessages || gmailListMessages;
  const injected = typeof opts.calendarListEvents === "function" || typeof opts.gmailListMessages === "function";
  const connected = injected || googleWorkspaceConfigured();
  if (!connected) {
    return {
      connected: false,
      events: [],
      messages: [],
      calendarError: null,
      inboxError: null,
    };
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const [cal, mail] = await Promise.all([
    Promise.resolve(listEvents({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      maxResults: 8,
    })).catch((err) => ({ ok: false, error: err?.message || "Calendar unavailable" })),
    Promise.resolve(listMessages({
      query: "is:unread newer_than:2d",
      maxResults: 8,
    })).catch((err) => ({ ok: false, error: err?.message || "Inbox unavailable" })),
  ]);

  return {
    connected: true,
    events: cal?.ok ? (cal.events || []).slice(0, 8) : [],
    messages: mail?.ok ? (mail.messages || []).slice(0, 8) : [],
    calendarError: cal?.ok ? null : (cal?.error || "Calendar unavailable"),
    inboxError: mail?.ok ? null : (mail?.error || "Inbox unavailable"),
  };
}

function appendOperatorSections(lines, ctx) {
  lines.push("");
  if (!ctx.connected) {
    lines.push("Today's calendar: not connected.");
    lines.push("Unread mail: not connected.");
    return;
  }
  lines.push("Today's calendar (UTC day):");
  if (ctx.calendarError) lines.push(`- unavailable (${clip(ctx.calendarError, 160)})`);
  else if (!ctx.events.length) lines.push("- nothing scheduled");
  else {
    for (const event of ctx.events) {
      lines.push(`- ${clockLabel(event.start)} ${clip(event.summary, 120)}`.trim());
    }
  }
  lines.push("Unread mail:");
  if (ctx.inboxError) lines.push(`- unavailable (${clip(ctx.inboxError, 160)})`);
  else if (!ctx.messages.length) lines.push("- inbox clear");
  else {
    for (const message of ctx.messages) {
      const from = clip(message.from, 80);
      const subject = clip(message.subject, 120);
      lines.push(`- ${from}${subject ? ` — ${subject}` : ""}`);
    }
  }
}

/**
 * Build a morning-brief payload for a user/workspace.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ storageUserId?: string, now?: Date, calendarListEvents?: Function, gmailListMessages?: Function }} [opts]
 */
export async function buildMorningBrief(userId, workspaceId, opts = {}) {
  const storageUserId = opts.storageUserId || (await resolveStorageUserId(userId, workspaceId));
  const status = await getAdviceModeStatus(storageUserId, workspaceId);
  const { thoughts, dueCount } = await resurfaceThoughts(userId, workspaceId, { limit: 12 });
  const { thoughts: all } = await listThoughts(userId, workspaceId, { limit: 5 });
  const hint = formatThoughtsHint(thoughts);
  const operator = await loadOperatorContext(opts);
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
  appendOperatorSections(lines, operator);
  const text = lines.join("\n");
  return {
    text,
    hint,
    adviceMode: status.enabled,
    challenge: status.challenge,
    thoughtCount: thoughts.length,
    dueCount,
    calendar: operator.events,
    inbox: operator.messages,
    sources: {
      journal: true,
      googleConnected: operator.connected,
      calendar: operator.connected && !operator.calendarError,
      inbox: operator.connected && !operator.inboxError,
    },
    promptForAgent:
      `You are the user's honest advice companion. Deliver this morning brief warmly but directly.\n\n${text}\n\n` +
      `Weigh the journal against today's calendar and unread mail. Do not invent meetings or emails that are not listed. ` +
      `If calendar or mail says it is not connected, mention that once and advise from the journal. ` +
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
  const ownerUserId = typeof opts.userId === "string" ? opts.userId.trim() : "";
  if (existing) {
    if (ownerUserId && existing.ownerUserId !== ownerUserId) {
      const updated = await updateScheduledAgent(workspaceId, existing.id, { ownerUserId });
      return { created: false, agent: updated || existing };
    }
    return { created: false, agent: existing };
  }

  const brief = await buildMorningBrief(ownerUserId || "anonymous", workspaceId);
  const agent = await createScheduledAgent({
    workspaceId,
    name: MORNING_BRIEF_AGENT_NAME,
    description: "Daily honest-advice brief from the journal, calendar, and unread mail",
    cron: opts.cron || DEFAULT_MORNING_BRIEF_CRON,
    prompt: brief.promptForAgent,
    agentMode: "single",
    ownerUserId,
  });
  return { created: true, agent };
}
