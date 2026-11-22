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
  gmailListMessages,
  calendarListEvents,
} from "./google-workspace-tools.js";

export const MORNING_BRIEF_AGENT_NAME = "Advice morning brief";
export const DEFAULT_MORNING_BRIEF_CRON = process.env.ADVICE_BRIEF_CRON || "0 8 * * *";
/** Scheduled-agent prompt cap. Calendar, mail, and closing instructions stay inside it. */
export const MORNING_BRIEF_PROMPT_MAX = 10000;
const THOUGHT_CLIP = 400;

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
  let accessToken = typeof opts.accessToken === "string" ? opts.accessToken.trim() : "";
  if (!injected && !accessToken) {
    const { resolveGoogleAccessToken } = await import("./google-user-connection.js");
    const resolved = await resolveGoogleAccessToken(opts.userId);
    accessToken = resolved?.token || "";
  }
  const connected = injected || Boolean(accessToken);
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
      accessToken: accessToken || undefined,
      userId: opts.userId,
    })).catch((err) => ({ ok: false, error: err?.message || "Calendar unavailable" })),
    Promise.resolve(listMessages({
      query: "is:unread newer_than:2d",
      maxResults: 8,
      accessToken: accessToken || undefined,
      userId: opts.userId,
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

const PROMPT_INTRO = "You are the user's honest advice companion. Deliver this morning brief warmly but directly.";
const PROMPT_CLOSING =
  "Weigh the journal against today's calendar and unread mail. Do not invent meetings or emails that are not listed. " +
  "If calendar or mail says it is not connected, mention that once and advise from the journal. " +
  "Ask one clarifying question if helpful, then give one concrete recommendation for the day.";

function thoughtLine(thought, max) {
  const kind = thought.metadata?.thoughtKind || "note";
  const content = max ? clip(thought.content, max) : String(thought.content || "");
  return `- [${kind}] ${content}`;
}

/**
 * Fit the model prompt under the scheduled-agent cap without dropping the
 * calendar, inbox, or closing instructions. Extra journal lines go first.
 * @param {{ header: string[], focus: object[], recent: object[], operatorLines: string[] }} parts
 */
function fitPromptForAgent(parts) {
  let focus = parts.focus.slice(0, 8);
  let recent = parts.focus.length ? [] : parts.recent.slice(0, 3);
  const compose = () => {
    const lines = [...parts.header];
    if (focus.length) {
      lines.push("Focus today:");
      for (const thought of focus) lines.push(thoughtLine(thought, THOUGHT_CLIP));
    } else if (recent.length) {
      lines.push("No due thoughts. Capture something you want honest advice on.");
      lines.push("", "Recent journal:");
      for (const thought of recent) lines.push(`- ${clip(thought.content, THOUGHT_CLIP)}`);
    } else {
      lines.push("No due thoughts. Capture something you want honest advice on.");
    }
    lines.push(...parts.operatorLines);
    return `${PROMPT_INTRO}\n\n${lines.join("\n")}\n\n${PROMPT_CLOSING}`;
  };
  let prompt = compose();
  while (prompt.length > MORNING_BRIEF_PROMPT_MAX && (focus.length || recent.length)) {
    if (focus.length > 1) focus = focus.slice(0, -1);
    else if (recent.length) recent = recent.slice(0, -1);
    else focus = [];
    prompt = compose();
  }
  if (prompt.length > MORNING_BRIEF_PROMPT_MAX) {
    const tail = `\n${parts.operatorLines.join("\n")}\n\n${PROMPT_CLOSING}`;
    const room = Math.max(0, MORNING_BRIEF_PROMPT_MAX - tail.length);
    prompt = `${prompt.slice(0, room).trimEnd()}${tail}`.slice(0, MORNING_BRIEF_PROMPT_MAX);
  }
  return prompt;
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
  const operator = await loadOperatorContext({ ...opts, userId });
  const header = [
    `Morning brief for workspace "${workspaceId}"`,
    `Advice mode: ${status.enabled ? "on" : "off"}${status.challenge ? " (challenge)" : ""}`,
    `Due / sticky thoughts: ${dueCount} due, ${thoughts.length} resurfaced`,
    "",
  ];
  const focus = thoughts.slice(0, 8);
  const recent = thoughts.length ? [] : all.slice(0, 3);
  const preview = [...header];
  if (focus.length) {
    preview.push("Focus today:");
    for (const thought of focus) preview.push(thoughtLine(thought));
  } else {
    preview.push("No due thoughts. Capture something you want honest advice on.");
  }
  if (recent.length) {
    preview.push("", "Recent journal:");
    for (const thought of recent) preview.push(`- ${thought.content}`);
  }
  const operatorLines = [];
  appendOperatorSections(operatorLines, operator);
  preview.push(...operatorLines);
  const text = preview.join("\n");
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
    promptForAgent: fitPromptForAgent({ header, focus, recent, operatorLines }),
  };
}

/**
 * Ensure a daily morning-brief scheduled agent exists for this user in the workspace.
 * One schedule per owner. A legacy schedule with no owner can be claimed once.
 * A later user does not replace an owner who is already set.
 * @param {string} workspaceId
 * @param {{ cron?: string, userId?: string }} [opts]
 */
export async function ensureMorningBriefSchedule(workspaceId, opts = {}) {
  const agents = await listScheduledAgents(workspaceId);
  const briefs = agents.filter((a) => a.name === MORNING_BRIEF_AGENT_NAME);
  const ownerUserId = typeof opts.userId === "string" ? opts.userId.trim() : "";
  const mine = ownerUserId
    ? briefs.find((a) => a.ownerUserId === ownerUserId)
    : briefs.find((a) => !a.ownerUserId);
  if (mine) return { created: false, agent: mine };

  if (ownerUserId) {
    const unowned = briefs.find((a) => !a.ownerUserId);
    if (unowned) {
      const updated = await updateScheduledAgent(workspaceId, unowned.id, { ownerUserId });
      return { created: false, agent: updated || unowned };
    }
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
