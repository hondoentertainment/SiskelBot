/**
 * Google Workspace agent tools (Gmail + Calendar).
 * Requires GOOGLE_WORKSPACE_ACCESS_TOKEN (OAuth user token with Gmail/Calendar scopes).
 * Send/create actions should be HITL-gated by the agent loop.
 */
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const CAL_API = "https://www.googleapis.com/calendar/v3";

export function googleWorkspaceConfigured() {
  return Boolean((process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN || "").trim());
}

function token() {
  const t = (process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN || "").trim();
  if (!t) {
    const err = new Error(
      "Google Workspace not connected. Set GOOGLE_WORKSPACE_ACCESS_TOKEN with Gmail/Calendar scopes.",
    );
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  return t;
}

async function gwFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Google API HTTP ${res.status}`);
    err.code = "GOOGLE_API_ERROR";
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

/**
 * @param {{ query?: string, maxResults?: number }} [opts]
 */
export async function gmailListMessages(opts = {}) {
  if (!googleWorkspaceConfigured()) {
    return { ok: false, code: "GOOGLE_NOT_CONFIGURED", error: "Set GOOGLE_WORKSPACE_ACCESS_TOKEN" };
  }
  try {
    const maxResults = Math.min(Math.max(1, Number(opts.maxResults) || 10), 25);
    const q = typeof opts.query === "string" ? opts.query.trim() : "";
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (q) params.set("q", q);
    const list = await gwFetch(`${GMAIL_API}/users/me/messages?${params}`);
    const ids = (list.messages || []).map((m) => m.id).slice(0, maxResults);
    const messages = [];
    for (const id of ids) {
      const full = await gwFetch(
        `${GMAIL_API}/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      );
      const headers = Object.fromEntries(
        (full.payload?.headers || []).map((h) => [String(h.name).toLowerCase(), h.value]),
      );
      messages.push({
        id,
        snippet: full.snippet || "",
        subject: headers.subject || "",
        from: headers.from || "",
        date: headers.date || "",
      });
    }
    return { ok: true, messages, count: messages.length };
  } catch (err) {
    return { ok: false, code: err.code || "GOOGLE_API_ERROR", error: err.message };
  }
}

/**
 * @param {{ to: string, subject: string, body: string }} opts
 */
export async function gmailSendMessage(opts = {}) {
  if (!googleWorkspaceConfigured()) {
    return { ok: false, code: "GOOGLE_NOT_CONFIGURED", error: "Set GOOGLE_WORKSPACE_ACCESS_TOKEN" };
  }
  const to = String(opts.to || "").trim();
  const subject = String(opts.subject || "").trim();
  const body = String(opts.body || "");
  if (!to || !subject) {
    return { ok: false, code: "INVALID_INPUT", error: "to and subject are required" };
  }
  try {
    const raw = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
      "\r\n",
    );
    const encoded = Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sent = await gwFetch(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw: encoded }),
    });
    return { ok: true, id: sent.id, threadId: sent.threadId };
  } catch (err) {
    return { ok: false, code: err.code || "GOOGLE_API_ERROR", error: err.message };
  }
}

/**
 * @param {{ timeMin?: string, timeMax?: string, maxResults?: number, calendarId?: string }} [opts]
 */
export async function calendarListEvents(opts = {}) {
  if (!googleWorkspaceConfigured()) {
    return { ok: false, code: "GOOGLE_NOT_CONFIGURED", error: "Set GOOGLE_WORKSPACE_ACCESS_TOKEN" };
  }
  try {
    const calendarId = encodeURIComponent(opts.calendarId || "primary");
    const maxResults = Math.min(Math.max(1, Number(opts.maxResults) || 10), 25);
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: opts.timeMin || new Date().toISOString(),
    });
    if (opts.timeMax) params.set("timeMax", opts.timeMax);
    const data = await gwFetch(`${CAL_API}/calendars/${calendarId}/events?${params}`);
    const events = (data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || "",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
      htmlLink: e.htmlLink || "",
    }));
    return { ok: true, events, count: events.length };
  } catch (err) {
    return { ok: false, code: err.code || "GOOGLE_API_ERROR", error: err.message };
  }
}

/**
 * @param {{ summary: string, start: string, end: string, description?: string, calendarId?: string }} opts
 */
export async function calendarCreateEvent(opts = {}) {
  if (!googleWorkspaceConfigured()) {
    return { ok: false, code: "GOOGLE_NOT_CONFIGURED", error: "Set GOOGLE_WORKSPACE_ACCESS_TOKEN" };
  }
  const summary = String(opts.summary || "").trim();
  const start = String(opts.start || "").trim();
  const end = String(opts.end || "").trim();
  if (!summary || !start || !end) {
    return { ok: false, code: "INVALID_INPUT", error: "summary, start, and end are required (ISO datetimes)" };
  }
  try {
    const calendarId = encodeURIComponent(opts.calendarId || "primary");
    const body = {
      summary,
      description: opts.description || "",
      start: { dateTime: start },
      end: { dateTime: end },
    };
    const created = await gwFetch(`${CAL_API}/calendars/${calendarId}/events`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, id: created.id, htmlLink: created.htmlLink || "" };
  } catch (err) {
    return { ok: false, code: err.code || "GOOGLE_API_ERROR", error: err.message };
  }
}

/** Tool names that must pause for human approval before executing. */
export const GOOGLE_HITL_TOOLS = new Set(["gmail_send_message", "calendar_create_event"]);

export function googleToolNeedsHitl(name) {
  if (process.env.AGENT_GOOGLE_HITL === "0") return false;
  // Default on for mutating Google tools
  return GOOGLE_HITL_TOOLS.has(name);
}
