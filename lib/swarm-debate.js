/**
 * Specialist debate round. After specialists produce initial drafts,
 * optionally run a single debate pass where each specialist sees the
 * others' outputs and can revise. This catches errors that the synthesizer
 * would otherwise launder into the final answer.
 *
 * Enabled when SWARM_DEBATE=1. The debate adds one extra LLM call per
 * specialist (opt-in; disabled by default).
 */

const DEFAULT_MAX_TOKENS = 400;

export function debateEnabled() {
  return process.env.SWARM_DEBATE === "1";
}

const DEBATE_PROMPT = `You are a specialist reviewing your own draft after seeing peers' drafts on the same task. If your draft has an error, omission, or contradiction exposed by a peer, revise it. Otherwise return your draft unchanged. Reply with a short plain-text final draft — no preamble, no meta commentary.`;

/**
 * Run one round of debate: for each specialist result, call the LLM with
 * a prompt that shows the specialist's own output plus the peers' outputs,
 * and collect a possibly-revised draft.
 *
 * @param {{
 *   results: Array<{ specialist: string, content?: string, output?: string, success?: boolean }>,
 *   userMessage: string,
 *   backendFetch: Function,
 *   url: string,
 *   model: string,
 *   headers?: object,
 *   maxTokens?: number,
 * }} params
 * @returns {Promise<Array<{ specialist: string, original: string, revised: string, changed: boolean }>>}
 */
export async function runDebateRound({
  results,
  userMessage,
  backendFetch,
  url,
  model,
  headers = {},
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (!Array.isArray(results) || results.length < 2) return [];
  if (typeof backendFetch !== "function" || !url || !model) return [];

  const getText = (r) => {
    if (typeof r?.content === "string") return r.content;
    if (typeof r?.output === "string") return r.output;
    return "";
  };

  const drafts = results.map((r) => ({ specialist: r.specialist, text: getText(r) }));
  const promises = drafts.map(async (d) => {
    const peers = drafts.filter((x) => x.specialist !== d.specialist);
    const peerBlock = peers
      .map((p) => `### Peer: ${p.specialist}\n${String(p.text || "").slice(0, 1500)}`)
      .join("\n\n");
    const body = {
      model,
      messages: [
        { role: "system", content: DEBATE_PROMPT },
        {
          role: "user",
          content: `User request: ${String(userMessage || "").slice(0, 800)}\n\nYour draft:\n${String(d.text || "").slice(0, 2000)}\n\nPeers' drafts:\n${peerBlock}`,
        },
      ],
      stream: false,
      max_tokens: maxTokens,
    };
    try {
      const resp = await backendFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!resp?.ok) return { specialist: d.specialist, original: d.text, revised: d.text, changed: false };
      const data = await resp.json().catch(() => null);
      const revised = data?.choices?.[0]?.message?.content;
      if (typeof revised !== "string" || !revised.trim()) {
        return { specialist: d.specialist, original: d.text, revised: d.text, changed: false };
      }
      return {
        specialist: d.specialist,
        original: d.text,
        revised: revised.trim(),
        changed: revised.trim() !== d.text.trim(),
      };
    } catch {
      return { specialist: d.specialist, original: d.text, revised: d.text, changed: false };
    }
  });

  return Promise.all(promises);
}
