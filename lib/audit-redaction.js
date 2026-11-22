/**
 * Redact secrets from audit rows and agent-run replay.
 * The stored log is unchanged; this is the read path.
 */
const SECRET_TEXT = /(sk_(?:live|test)_[A-Za-z0-9]+|rk_(?:live|test)_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*|postgres(?:ql)?:\/\/\S+)/gi;
const SECRET_KEY = /token|secret|password|authorization|api.?key|connectionstring|cookie/i;

export function redactSecrets(value) {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[redacted]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

export function searchAuditEntries(entries, { q, action } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (Array.isArray(entries) ? entries : [])
    .map(redactSecrets)
    .filter((entry) => {
      if (action && entry.action !== action && entry.event !== action) return false;
      if (!needle) return true;
      return JSON.stringify(entry).toLowerCase().includes(needle);
    })
    .slice(0, 100);
}

export function replaySteps(trajectory) {
  const events = Array.isArray(trajectory?.events)
    ? trajectory.events
    : Array.isArray(trajectory?.steps)
      ? trajectory.steps
      : [];
  return events.map((event, index) => ({
    index,
    type: event.type || event.action || "step",
    name: event.name || event.tool || null,
    at: event.at || event.timestamp || null,
    detail: redactSecrets(event.detail || event.payload || event.args || null),
    ok: event.ok,
  }));
}
