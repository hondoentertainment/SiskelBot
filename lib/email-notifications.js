/**
 * Phase 8-R: Email Notifications via SMTP (nodemailer)
 *
 * Configuration:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS - SMTP settings
 *   SMTP_FROM - default sender (e.g. "SiskelBot <noreply@example.com>")
 *   EMAIL_DIGEST_ENABLED - enable daily digest emails
 *   EMAIL_DIGEST_RECIPIENTS - comma-separated email addresses
 */

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "SiskelBot <noreply@example.com>",
    digestEnabled: process.env.EMAIL_DIGEST_ENABLED === "1",
    digestRecipients: (process.env.EMAIL_DIGEST_RECIPIENTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

let _nodemailer = null;
let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;
  if (!_nodemailer) {
    try {
      _nodemailer = await import("nodemailer");
    } catch {
      throw new Error("nodemailer is not installed. Install it with: npm install nodemailer");
    }
  }
  const nm = _nodemailer.default || _nodemailer;
  const smtp = smtpConfig();
  _transporter = nm.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return _transporter;
}

/**
 * Check whether email sending is configured.
 */
export function isEmailConfigured() {
  return Boolean(smtpConfig().host);
}

/**
 * Send an email via SMTP.
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body (text or HTML)
 * @param {object} [options] - { html?: boolean, from?: string, replyTo?: string }
 */
function headerValue(value, label) {
  const text = String(value || "");
  if (/[\r\n]/.test(text)) throw new Error(`${label} contains a line break`);
  return text;
}

export async function sendEmail(to, subject, body, options = {}) {
  if (!isEmailConfigured()) {
    throw new Error("Email not configured (set SMTP_HOST)");
  }
  if (!to || typeof to !== "string") throw new Error("Recipient (to) is required");
  if (!subject || typeof subject !== "string") throw new Error("Subject is required");
  const mailOptions = {
    from: headerValue(options.from || smtpConfig().from, "from"),
    to: headerValue(to, "to"),
    subject: headerValue(subject, "subject"),
  };
  const transporter = await getTransporter();
  if (options.replyTo) mailOptions.replyTo = headerValue(options.replyTo, "replyTo");
  if (options.html) {
    mailOptions.html = body;
  } else {
    mailOptions.text = body;
  }

  const info = await transporter.sendMail(mailOptions);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

/**
 * Build an HTML digest email from recent events.
 * @param {object[]} events - Array of event objects
 * @param {string} period - e.g. "daily", "weekly"
 * @returns {string} HTML string
 */
function buildDigestHtml(events, period) {
  const agentRuns = events.filter((e) => e.event === "swarm_completed" || e.event === "swarm_started");
  const recipeEvents = events.filter((e) => e.event === "recipe_executed" || e.event === "schedule_completed");
  const auditEvents = events.filter((e) => e.type === "audit" || e.event === "plan_created");
  const quotaWarnings = events.filter((e) => e.type === "quota_warning");

  const totalAgentRuns = agentRuns.length;
  const successfulRuns = agentRuns.filter((e) => e.data?.success !== false).length;
  const successRate = totalAgentRuns > 0 ? Math.round((successfulRuns / totalAgentRuns) * 100) : 0;

  const rows = [];

  rows.push("<h2>Agent Runs</h2>");
  if (totalAgentRuns > 0) {
    rows.push(`<p>${totalAgentRuns} run(s), ${successRate}% success rate</p>`);
    rows.push("<ul>");
    for (const e of agentRuns.slice(0, 10)) {
      const ts = e.timestamp || "";
      const status = e.data?.success === false ? "failed" : "ok";
      rows.push(`<li>${ts} &mdash; ${e.event} [${status}]</li>`);
    }
    rows.push("</ul>");
  } else {
    rows.push("<p>No agent runs in this period.</p>");
  }

  rows.push("<h2>Recipe Executions</h2>");
  if (recipeEvents.length > 0) {
    rows.push("<ul>");
    for (const e of recipeEvents.slice(0, 10)) {
      const name = e.data?.recipeName || e.data?.recipeId || "unknown";
      rows.push(`<li>${e.timestamp || ""} &mdash; ${name}</li>`);
    }
    rows.push("</ul>");
  } else {
    rows.push("<p>No recipe executions in this period.</p>");
  }

  rows.push("<h2>Audit Events</h2>");
  if (auditEvents.length > 0) {
    rows.push("<ul>");
    for (const e of auditEvents.slice(0, 10)) {
      rows.push(`<li>${e.timestamp || ""} &mdash; ${e.event || e.action || "event"}</li>`);
    }
    rows.push("</ul>");
  } else {
    rows.push("<p>No notable audit events.</p>");
  }

  if (quotaWarnings.length > 0) {
    rows.push("<h2>Quota Warnings</h2>");
    rows.push("<ul>");
    for (const w of quotaWarnings.slice(0, 5)) {
      rows.push(`<li>${w.message || "Quota threshold reached"}</li>`);
    }
    rows.push("</ul>");
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SiskelBot ${period} Digest</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
<h1>SiskelBot ${period.charAt(0).toUpperCase() + period.slice(1)} Digest</h1>
<p>Period: ${period} &mdash; Generated: ${new Date().toISOString()}</p>
<hr>
${rows.join("\n")}
<hr>
<p style="color:#888; font-size:12px;">This digest was generated automatically by SiskelBot.</p>
</body>
</html>`;
}

/**
 * Compile recent events into an email digest and send to recipient(s).
 * @param {string|string[]} to - Recipient(s)
 * @param {object[]} events - Recent event objects
 * @param {string} period - "daily", "weekly", etc.
 */
export async function sendDigest(to, events, period = "daily") {
  const recipients = Array.isArray(to) ? to : [to];
  const html = buildDigestHtml(events || [], period);
  const subject = `SiskelBot ${period} digest - ${new Date().toISOString().slice(0, 10)}`;

  const results = [];
  for (const addr of recipients) {
    try {
      const r = await sendEmail(addr, subject, html, { html: true });
      results.push({ to: addr, ok: true, messageId: r.messageId });
    } catch (err) {
      results.push({ to: addr, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Get the configured digest recipients.
 */
export function getDigestRecipients() {
  return smtpConfig().digestRecipients;
}

/**
 * Check if digest is enabled.
 */
export function isDigestEnabled() {
  const smtp = smtpConfig();
  return smtp.digestEnabled && smtp.digestRecipients.length > 0 && isEmailConfigured();
}

/**
 * Reset transporter (for testing).
 */
export function _resetTransporter() {
  _transporter = null;
}
