/**
 * Redact secrets from audit rows and agent-run replay.
 * The stored log is unchanged; this is the read path.
 */
const SECRET_TEXT = /sk_(?:live|test)_[A-Za-z0-9]+|rk_(?:live|test)_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|ya29\.[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;
const SECRET_KEY = /token|secret|password|authorization|api.?key|connectionstring|cookie|credential|private.?key|refresh|session/i;

export function redactSecrets(value) {
  if (typeof value === "string") return value.replace(new RegExp(SECRET_TEXT.source, "gi"), "[redacted]");
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
  return events.map((event, index) => {
    const safe = redactSecrets(event);
    return {
      index,
      type: safe.type || safe.action || "step",
      name: safe.name || safe.tool || null,
      at: safe.at || safe.timestamp || null,
      detail: safe.detail || safe.payload || safe.args || null,
      result: safe.result || safe.output || safe.content || null,
      ok: safe.ok,
    };
  });
}
