/**
 * Phase 37.3: Email push adapter.
 *
 * Delivers notifications as emails using the existing SMTP transport in
 * lib/email-notifications.js. Acts as a fallback channel when a user's
 * mobile/web push subscriptions are unavailable or a notification should
 * always reach an inbox.
 */
import { sendEmail, isEmailConfigured } from "../email-notifications.js";

export function isEmailAdapterConfigured() {
  return isEmailConfigured();
}

/**
 * Send a notification as an email.
 * @param {string} to - Recipient email address
 * @param {object} notification - { title, body, data? }
 */
export async function sendEmailPush(to, notification) {
  if (!to) return { ok: false, error: "recipient required" };
  if (!isEmailConfigured()) {
    return { ok: false, error: "email not configured (set SMTP_HOST)" };
  }

  const subject = notification.title || "Notification";
  const lines = [notification.body || ""];
  if (notification.data && typeof notification.data === "object") {
    lines.push("");
    for (const [k, v] of Object.entries(notification.data)) {
      lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  const body = lines.join("\n");

  try {
    const res = await sendEmail(to, subject, body);
    return { ok: true, id: res.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
