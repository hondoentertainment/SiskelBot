/**
 * Phase 60: Optional default system instructions for agent mode and swarm (deployment-wide personalization).
 * Applied before citation grounding. Does not replace client-provided system messages — appends or prepends a block.
 */
const MAX_DEFAULT_SYSTEM_CHARS = Math.min(
  32_000,
  Math.max(256, Number(process.env.AGENT_DEFAULT_SYSTEM_MAX_CHARS) || 8000)
);

/**
 * @returns {string}
 */
export function getDefaultAgentSystemFromEnv() {
  const raw = process.env.AGENT_DEFAULT_SYSTEM;
  if (typeof raw !== "string" || !raw.trim()) return "";
  const t = raw.trim();
  return t.length > MAX_DEFAULT_SYSTEM_CHARS ? t.slice(0, MAX_DEFAULT_SYSTEM_CHARS) : t;
}

/**
 * @param {Array<{ role?: string; content?: string }>} messages
 * @returns {Array<{ role?: string; content?: string }>}
 */
export function augmentMessagesWithDefaultSystem(messages) {
  const extra = getDefaultAgentSystemFromEnv();
  if (!extra) return Array.isArray(messages) ? [...messages] : [];
  const out = Array.isArray(messages) ? [...messages] : [];
  if (out.length === 0) {
    return [{ role: "system", content: extra }];
  }
  const first = out[0];
  if (first && first.role === "system" && typeof first.content === "string") {
    const base = first.content.trimEnd();
    out[0] = { ...first, content: base ? `${base}\n\n${extra}` : extra };
  } else {
    out.unshift({ role: "system", content: extra });
  }
  return out;
}

export function defaultAgentSystemConfigured() {
  return getDefaultAgentSystemFromEnv().length > 0;
}
