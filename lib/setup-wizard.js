/**
 * Operator setup checks. Reports configured / working / error / off.
 * Never returns secret values.
 */

const FLAGS = [
  ["BROWSER_FILE_TRANSFER", "Browser file transfer"],
  ["AGENT_BROWSER_TOOLS", "Browser page tools"],
  ["OPENAPI_TOOLS_ENABLED", "OpenAPI tools"],
  ["OPENAPI_TOOLS_WRITE", "OpenAPI write calls"],
  ["WORKSPACE_MCP_ENABLED", "Workspace MCP calls"],
  ["AGENT_DB_QUERY", "Governed SQL"],
  ["GOOGLE_WORKSPACE_WRITE_SCOPES", "Google send and create scopes"],
];

function present(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function safeDetail(err) {
  return String(err?.message || err || "check failed")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***")
    .replace(/(pass(word)?|secret|token|key)\s*[=:]\s*\S+/gi, "$1=***")
    .slice(0, 180);
}

export function listSetupFlags() {
  return FLAGS.map(([name, label]) => {
    const on = process.env[name] === "1";
    return {
      id: name,
      label,
      state: on ? "on" : "off",
      detail: on ? "Enabled in this process" : "Off by default",
    };
  });
}

export async function googleOauthCheck() {
  const ready = present("GOOGLE_CLIENT_ID") && present("GOOGLE_CLIENT_SECRET");
  if (!ready) {
    return {
      id: "google_oauth",
      label: "Google OAuth client",
      state: "missing",
      detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Redirect URI is /api/v1/google/workspace/callback.",
    };
  }
  return {
    id: "google_oauth",
    label: "Google OAuth client",
    state: "configured",
    detail: "Client id and secret are set. Add /api/v1/google/workspace/callback in Google Cloud.",
  };
}

export async function smtpCheck(deps = {}) {
  if (!present("SMTP_HOST")) {
    return { id: "smtp", label: "Email delivery", state: "missing", detail: "Set SMTP_HOST to send brief email." };
  }
  const verify = deps.verifySmtp;
  if (typeof verify !== "function") {
    return { id: "smtp", label: "Email delivery", state: "configured", detail: "SMTP host is set. A live verify probe was not run." };
  }
  try {
    await verify();
    return { id: "smtp", label: "Email delivery", state: "working", detail: "SMTP server accepted the connection." };
  } catch (err) {
    return { id: "smtp", label: "Email delivery", state: "error", detail: safeDetail(err) };
  }
}

export async function slackCheck(deps = {}) {
  const webhook = present("SLACK_WEBHOOK_URL");
  const token = present("SLACK_BOT_TOKEN");
  if (!webhook && !token) {
    return { id: "slack", label: "Slack delivery", state: "missing", detail: "Set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL." };
  }
  if (!token) {
    return { id: "slack", label: "Slack delivery", state: "configured", detail: "Webhook is set. This check does not post a message." };
  }
  const probe = deps.slackAuth || (async () => {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `Slack HTTP ${res.status}`);
      throw err;
    }
    return json;
  });
  try {
    await probe();
    return { id: "slack", label: "Slack delivery", state: "working", detail: "Slack auth.test succeeded." };
  } catch (err) {
    return { id: "slack", label: "Slack delivery", state: "error", detail: safeDetail(err) };
  }
}

export async function stripeCheck(deps = {}) {
  const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) {
    return {
      id: "stripe",
      label: "Stripe live key",
      state: "missing",
      detail: "Set STRIPE_SECRET_KEY in the host environment. This app does not store it.",
    };
  }
  const live = key.startsWith("sk_live_") || key.startsWith("rk_live_");
  const test = key.startsWith("sk_test_") || key.startsWith("rk_test_");
  if (test) {
    return {
      id: "stripe",
      label: "Stripe live key",
      state: "configured",
      detail: "A test key is set. Live billing needs a live secret key from the Stripe dashboard.",
    };
  }
  const probe = deps.stripeBalance || (async () => {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const err = new Error(`Stripe rejected the key (HTTP ${res.status})`);
      throw err;
    }
  });
  try {
    await probe();
    return {
      id: "stripe",
      label: "Stripe live key",
      state: live ? "working" : "configured",
      detail: live ? "Live key was accepted by Stripe." : "Key was accepted. Confirm it is a live secret in the Stripe dashboard.",
    };
  } catch (err) {
    return { id: "stripe", label: "Stripe live key", state: "error", detail: safeDetail(err) };
  }
}

export async function buildSetupReport(deps = {}) {
  const checks = await Promise.all([
    googleOauthCheck(),
    smtpCheck(deps),
    slackCheck(deps),
    stripeCheck(deps),
  ]);
  return {
    checks,
    flags: listSetupFlags(),
  };
}
