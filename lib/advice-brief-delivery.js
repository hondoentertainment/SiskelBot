/**
 * Deliver a finished morning brief.
 * The advice page always reads the stored run. Email, push, and Slack
 * send only when that user opted in. All three default off.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { listScheduledAgents, getScheduledAgentRuns } from "./scheduled-agents.js";
import { MORNING_BRIEF_AGENT_NAME } from "./advice-brief.js";
import { sendEmail, isEmailConfigured } from "./email-notifications.js";
import { notifyUser } from "./push-notifications.js";
import { notifySlack, isSlackConfigured } from "./slack-bot.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function prefsPath(userId) {
  const id = String(userId || "anonymous").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "anonymous";
  return join(getDataDir(), "users", id, "brief-delivery.json");
}

export function normalizeDeliveryPrefs(raw = {}) {
  return {
    email: raw.email === true,
    push: raw.push === true,
    slack: raw.slack === true,
    emailTo: typeof raw.emailTo === "string" ? raw.emailTo.trim().slice(0, 200) : "",
  };
}

export async function getBriefDeliveryPrefs(userId) {
  const stored = await readJsonPath(prefsPath(userId), {});
  return normalizeDeliveryPrefs(stored);
}

export async function saveBriefDeliveryPrefs(userId, raw) {
  const prefs = normalizeDeliveryPrefs(raw);
  if (prefs.email && !EMAIL_RE.test(prefs.emailTo)) {
    const err = new Error("A valid emailTo is required when email delivery is on");
    err.code = "INVALID_INPUT";
    throw err;
  }
  await writeJsonPath(prefsPath(userId), { ...prefs, updatedAt: new Date().toISOString() });
  return prefs;
}

/**
 * Latest morning-brief run for this owner. Does not return another user's run.
 */
export async function latestMorningBriefRun(workspaceId, userId) {
  const agents = await listScheduledAgents(workspaceId);
  const owner = String(userId || "").trim();
  const mine = agents.find((a) => a.name === MORNING_BRIEF_AGENT_NAME && a.ownerUserId === owner);
  if (!mine) return { agentId: null, run: null };
  const runs = await getScheduledAgentRuns(workspaceId, mine.id, 10);
  const run = runs.find((r) => r.status === "completed" && r.response) || null;
  if (!run) return { agentId: mine.id, run: null };
  return {
    agentId: mine.id,
    run: {
      runId: run.runId,
      status: run.status,
      response: String(run.response || "").slice(0, 8000),
      error: run.error || null,
      createdAt: run.createdAt,
    },
  };
}

/**
 * Send the finished recommendation through the channels the user turned on.
 * @param {{ workspaceId: string, userId?: string, response: string, runId?: string }} input
 * @param {{ prefs?: object, sendEmail?: Function, notifyUser?: Function, notifySlack?: Function, emailConfigured?: boolean, slackConfigured?: boolean }} [deps]
 */
export async function deliverFinishedBrief(input, deps = {}) {
  const text = String(input?.response || "").trim();
  const userId = input?.userId || "anonymous";
  if (!text) return { delivered: { email: false, push: false, slack: false }, errors: [], skipped: "empty" };

  const prefs = deps.prefs || (await getBriefDeliveryPrefs(userId));
  const delivered = { email: false, push: false, slack: false };
  const errors = [];
  const sendMail = deps.sendEmail || sendEmail;
  const push = deps.notifyUser || notifyUser;
  const slack = deps.notifySlack || notifySlack;
  const emailReady = deps.emailConfigured ?? isEmailConfigured();
  const slackReady = deps.slackConfigured ?? isSlackConfigured();

  if (prefs.email && prefs.emailTo) {
    if (!emailReady) errors.push({ channel: "email", error: "Email not configured" });
    else {
      try {
        await sendMail(prefs.emailTo, "Your morning brief", text.slice(0, 8000));
        delivered.email = true;
      } catch (err) {
        errors.push({ channel: "email", error: err.message });
      }
    }
  }

  if (prefs.push && userId !== "anonymous") {
    try {
      const sent = await push(userId, "Morning brief", text.slice(0, 180), {
        runId: input.runId || "",
        workspaceId: input.workspaceId || "",
      });
      delivered.push = Number(sent?.sent) > 0;
      if (!delivered.push) errors.push({ channel: "push", error: "No device accepted the notification" });
    } catch (err) {
      errors.push({ channel: "push", error: err.message });
    }
  }

  if (prefs.slack) {
    if (!slackReady) errors.push({ channel: "slack", error: "Slack not configured" });
    else {
      try {
        await slack("schedule_completed", {
          schedule: "Advice morning brief",
          name: "Advice morning brief",
          summary: text.slice(0, 500),
          workspaceId: input.workspaceId || "default",
        });
        delivered.slack = true;
      } catch (err) {
        errors.push({ channel: "slack", error: err.message });
      }
    }
  }

  return { delivered, errors };
}
