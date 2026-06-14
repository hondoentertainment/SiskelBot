/**
 * Phase 39.1: Cohort analysis — retention tracking by signup cohort.
 *
 * Records user signup events and per-user activity, and exposes
 * cohort-based retention, churn, DAU/MAU, and feature-adoption queries.
 *
 * Storage layout (via lib/json-path-store.js):
 *   data/cohorts/signups.json   -> { _version: 1, signups: [{ userId, workspaceId, cohortDay, cohortWeek, cohortMonth, signupAt, metadata }] }
 *   data/cohorts/activity.json  -> { _version: 1, events: [{ userId, workspaceId, eventType, day, ts }] }
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const MAX_SIGNUP_ENTRIES = 200_000;
const MAX_ACTIVITY_ENTRIES = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function signupsPath() {
  return join(getDataDir(), "cohorts", "signups.json");
}

function activityPath() {
  return join(getDataDir(), "cohorts", "activity.json");
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a Date as YYYY-MM-DD (UTC).
 * @param {Date} d
 * @returns {string}
 */
export function toDayKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Format a Date as YYYY-MM (UTC).
 */
export function toMonthKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Format a Date as ISO week key YYYY-W## (ISO 8601).
 */
export function toWeekKey(d) {
  // Copy and shift to Thursday of current ISO week
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * DAY_MS));
  return `${target.getUTCFullYear()}-W${pad2(week)}`;
}

/**
 * Day index difference (UTC) between two day keys (YYYY-MM-DD).
 */
function daysBetween(fromDayKey, toDayKey) {
  const a = Date.parse(`${fromDayKey}T00:00:00Z`);
  const b = Date.parse(`${toDayKey}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

async function loadSignups() {
  const path = signupsPath();
  const data = await readJsonPath(path, { _version: 1, signups: [] });
  return Array.isArray(data.signups) ? data.signups : [];
}

async function saveSignups(signups) {
  const path = signupsPath();
  const trimmed = signups.length > MAX_SIGNUP_ENTRIES ? signups.slice(-MAX_SIGNUP_ENTRIES) : signups;
  await writeJsonPath(path, { _version: 1, signups: trimmed });
}

async function loadActivity() {
  const path = activityPath();
  const data = await readJsonPath(path, { _version: 1, events: [] });
  return Array.isArray(data.events) ? data.events : [];
}

async function saveActivity(events) {
  const path = activityPath();
  const trimmed = events.length > MAX_ACTIVITY_ENTRIES ? events.slice(-MAX_ACTIVITY_ENTRIES) : events;
  await writeJsonPath(path, { _version: 1, events: trimmed });
}

/**
 * Record a user signup. Idempotent per (userId, workspaceId).
 * @param {string} userId
 * @param {string} workspaceId
 * @param {object} [metadata]
 * @returns {Promise<object>} the stored signup record
 */
export async function recordUserSignup(userId, workspaceId, metadata = {}) {
  if (!userId) throw new Error("recordUserSignup: userId required");
  const ws = workspaceId || "default";
  const path = signupsPath();
  return withPathLock(path, async () => {
    const signups = await loadSignups();
    const existing = signups.find((s) => s.userId === userId && s.workspaceId === ws);
    if (existing) return existing;
    const now = new Date();
    const rec = {
      userId: String(userId),
      workspaceId: String(ws),
      signupAt: now.toISOString(),
      cohortDay: toDayKey(now),
      cohortWeek: toWeekKey(now),
      cohortMonth: toMonthKey(now),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    signups.push(rec);
    await saveSignups(signups);
    return rec;
  });
}

/**
 * Record a user activity event. Best-effort: failures swallowed.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} eventType - e.g. 'request', 'agent_mode', 'login'
 */
export async function recordUserActivity(userId, workspaceId, eventType) {
  if (!userId || userId === "anonymous") return null;
  const ws = workspaceId || "default";
  const type = String(eventType || "request");
  const path = activityPath();
  try {
    return await withPathLock(path, async () => {
      const events = await loadActivity();
      const now = new Date();
      const rec = {
        userId: String(userId),
        workspaceId: String(ws),
        eventType: type,
        day: toDayKey(now),
        ts: now.toISOString(),
      };
      events.push(rec);
      await saveActivity(events);
      return rec;
    });
  } catch (_) {
    return null;
  }
}

function cohortKeyForGranularity(signup, granularity) {
  if (granularity === "month") return signup.cohortMonth;
  if (granularity === "week") return signup.cohortWeek;
  return signup.cohortDay;
}

function eventCohortKey(eventDay, granularity) {
  const d = new Date(`${eventDay}T00:00:00Z`);
  if (granularity === "month") return toMonthKey(d);
  if (granularity === "week") return toWeekKey(d);
  return eventDay;
}

function periodLengthDays(granularity) {
  if (granularity === "month") return 30;
  if (granularity === "week") return 7;
  return 1;
}

/**
 * Cohort retention matrix.
 * @param {object} options
 * @param {'day'|'week'|'month'} [options.cohortGranularity='week']
 * @param {number} [options.periods=12]
 * @param {string} [options.startDate] ISO date filtering signups on/after
 * @returns {Promise<{ granularity: string, periods: number, cohorts: Array }>}
 */
export async function getCohortRetention(options = {}) {
  const granularity = options.cohortGranularity || "week";
  const periods = Math.max(1, Math.min(60, Number(options.periods) || 12));
  const startDate = options.startDate ? Date.parse(options.startDate) : null;

  const [signups, events] = await Promise.all([loadSignups(), loadActivity()]);

  // Group signups by cohort key.
  const cohortMembers = new Map(); // cohortKey -> Set<userId>
  const cohortStartDay = new Map(); // cohortKey -> earliest signupDay (YYYY-MM-DD)

  for (const s of signups) {
    if (startDate && Date.parse(s.signupAt || "") < startDate) continue;
    const key = cohortKeyForGranularity(s, granularity);
    if (!key) continue;
    if (!cohortMembers.has(key)) {
      cohortMembers.set(key, new Set());
      cohortStartDay.set(key, s.cohortDay);
    } else {
      const prev = cohortStartDay.get(key);
      if (!prev || (s.cohortDay && s.cohortDay < prev)) cohortStartDay.set(key, s.cohortDay);
    }
    cohortMembers.get(key).add(s.userId);
  }

  // Index activity by userId for quick lookup.
  const userActivityDays = new Map(); // userId -> Set<dayKey>
  for (const e of events) {
    if (!userActivityDays.has(e.userId)) userActivityDays.set(e.userId, new Set());
    userActivityDays.get(e.userId).add(e.day);
  }

  const periodLen = periodLengthDays(granularity);
  const cohorts = [];
  const sortedKeys = [...cohortMembers.keys()].sort();
  for (const key of sortedKeys) {
    const members = cohortMembers.get(key);
    const startDay = cohortStartDay.get(key);
    const size = members.size;
    const retention = new Array(periods).fill(0);

    if (size > 0 && startDay) {
      for (let p = 0; p < periods; p++) {
        const periodStart = p * periodLen;
        const periodEnd = (p + 1) * periodLen;
        let active = 0;
        for (const userId of members) {
          const days = userActivityDays.get(userId);
          if (!days) continue;
          let found = false;
          for (const d of days) {
            const offset = daysBetween(startDay, d);
            if (offset >= periodStart && offset < periodEnd) {
              found = true;
              break;
            }
          }
          if (found) active += 1;
        }
        retention[p] = Math.round((active / size) * 10000) / 10000;
      }
    }

    cohorts.push({
      date: key,
      size,
      retention,
    });
  }

  return { granularity, periods, cohorts };
}

/**
 * Percent of a cohort that ever performed a given event type.
 * @param {string} feature - eventType
 * @param {string} cohortDate - cohort key (matching the granularity used at signup; tries day/week/month)
 * @returns {Promise<{ feature: string, cohortDate: string, cohortSize: number, adopted: number, percent: number }>}
 */
export async function getCohortFeatureAdoption(feature, cohortDate) {
  if (!feature) throw new Error("getCohortFeatureAdoption: feature required");
  if (!cohortDate) throw new Error("getCohortFeatureAdoption: cohortDate required");
  const [signups, events] = await Promise.all([loadSignups(), loadActivity()]);
  const members = new Set();
  for (const s of signups) {
    if (s.cohortDay === cohortDate || s.cohortWeek === cohortDate || s.cohortMonth === cohortDate) {
      members.add(s.userId);
    }
  }
  let adopted = 0;
  if (members.size > 0) {
    const seen = new Set();
    for (const e of events) {
      if (e.eventType === feature && members.has(e.userId)) seen.add(e.userId);
    }
    adopted = seen.size;
  }
  const percent = members.size > 0 ? Math.round((adopted / members.size) * 10000) / 100 : 0;
  return {
    feature,
    cohortDate,
    cohortSize: members.size,
    adopted,
    percent,
  };
}

/**
 * Churn rate over a trailing window.
 * A user is "active" if they had any activity in the window.
 * "Churned" = signed up before the window started AND was active in the prior
 * window of the same length but had no activity in the current window.
 * @param {string|number} period - e.g. '30d' or number of days
 * @returns {Promise<{ period: string, days: number, activeUsers: number, churnedUsers: number, churnRate: number }>}
 */
export async function getChurnRate(period = "30d") {
  const days = typeof period === "number"
    ? period
    : (() => {
        const m = String(period).match(/^(\d+)\s*d?$/i);
        return m ? Number(m[1]) : 30;
      })();
  const now = Date.now();
  const windowStart = now - days * DAY_MS;
  const priorStart = now - 2 * days * DAY_MS;

  const events = await loadActivity();
  const activeNow = new Set();
  const activePrior = new Set();
  for (const e of events) {
    const ts = Date.parse(e.ts || `${e.day}T00:00:00Z`);
    if (Number.isNaN(ts)) continue;
    if (ts >= windowStart && ts <= now) activeNow.add(e.userId);
    else if (ts >= priorStart && ts < windowStart) activePrior.add(e.userId);
  }

  let churned = 0;
  for (const userId of activePrior) {
    if (!activeNow.has(userId)) churned += 1;
  }
  const denom = activePrior.size;
  const churnRate = denom > 0 ? Math.round((churned / denom) * 10000) / 10000 : 0;
  return {
    period: typeof period === "string" ? period : `${days}d`,
    days,
    activeUsers: activeNow.size,
    churnedUsers: churned,
    churnRate,
  };
}

/**
 * Daily active users for the last N days.
 * @param {number} days
 * @returns {Promise<{ days: number, series: Array<{ day: string, users: number }>, average: number }>}
 */
export async function getDailyActiveUsers(days = 30) {
  const n = Math.max(1, Math.min(365, Number(days) || 30));
  const events = await loadActivity();
  const now = new Date();
  const series = [];
  const dayBuckets = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = toDayKey(d);
    dayBuckets.set(key, new Set());
  }
  for (const e of events) {
    if (dayBuckets.has(e.day)) dayBuckets.get(e.day).add(e.userId);
  }
  let total = 0;
  for (const [day, users] of dayBuckets) {
    series.push({ day, users: users.size });
    total += users.size;
  }
  const average = series.length > 0 ? Math.round((total / series.length) * 100) / 100 : 0;
  return { days: n, series, average };
}

/**
 * Monthly active users for the last N months.
 * @param {number} months
 * @returns {Promise<{ months: number, series: Array<{ month: string, users: number }>, average: number }>}
 */
export async function getMonthlyActiveUsers(months = 12) {
  const n = Math.max(1, Math.min(60, Number(months) || 12));
  const events = await loadActivity();
  const now = new Date();
  const buckets = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.set(toMonthKey(d), new Set());
  }
  for (const e of events) {
    const d = new Date(`${e.day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const key = toMonthKey(d);
    if (buckets.has(key)) buckets.get(key).add(e.userId);
  }
  const series = [];
  let total = 0;
  for (const [month, users] of buckets) {
    series.push({ month, users: users.size });
    total += users.size;
  }
  const average = series.length > 0 ? Math.round((total / series.length) * 100) / 100 : 0;
  return { months: n, series, average };
}

/**
 * Test/maintenance helper: clear all cohort data.
 */
export async function _resetCohortStore() {
  await withPathLock(signupsPath(), async () => {
    await writeJsonPath(signupsPath(), { _version: 1, signups: [] });
  });
  await withPathLock(activityPath(), async () => {
    await writeJsonPath(activityPath(), { _version: 1, events: [] });
  });
}
