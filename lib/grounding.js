/**
 * Phase 57: Grounding / citations — system nudge and answer checks for RAG-style tool use.
 */
const CITATION_SYSTEM_TEXT =
  "When your answer uses information from search_context results, cite sources: include each relevant " +
  "document id in square brackets (e.g. [doc-id-123]) or the exact document title in quotes. " +
  "Do not claim facts from context without citing at least one matching source id or title.";

export function citationsRequired() {
  return process.env.AGENT_REQUIRE_CITATIONS === "1";
}

/**
 * Inject citation instructions (Phase 57) when enabled.
 * @param {Array<{ role: string; content?: string }>} messages
 * @returns {Array<{ role: string; content?: string }>}
 */
export function augmentMessagesForGrounding(messages) {
  if (!citationsRequired() || !Array.isArray(messages)) return messages;
  const copy = [...messages];
  const sysIdx = copy.findIndex((m) => m && m.role === "system");
  if (sysIdx >= 0 && typeof copy[sysIdx].content === "string") {
    copy[sysIdx] = { ...copy[sysIdx], content: `${copy[sysIdx].content}\n\n${CITATION_SYSTEM_TEXT}` };
  } else {
    copy.unshift({ role: "system", content: CITATION_SYSTEM_TEXT });
  }
  return copy;
}

/**
 * Extract ids and titles from a search_context tool result JSON string.
 * @param {string} toolContent
 * @returns {{ ids: Set<string>; titles: Set<string> }}
 */
export function extractCitationTargetsFromSearchResult(toolContent) {
  const ids = new Set();
  const titles = new Set();
  if (typeof toolContent !== "string" || !toolContent.trim()) return { ids, titles };
  try {
    const data = JSON.parse(toolContent);
    const snippets = data.snippets;
    if (!Array.isArray(snippets)) return { ids, titles };
    for (const s of snippets) {
      if (s && typeof s.id === "string" && s.id.trim()) ids.add(s.id.trim());
      if (s && typeof s.title === "string" && s.title.trim()) titles.add(s.title.trim().toLowerCase());
    }
  } catch (_) {}
  return { ids, titles };
}

/**
 * True if final answer references at least one known id (substring) or title (case-insensitive).
 * @param {string} answer
 * @param {Set<string>} ids
 * @param {Set<string>} titlesLowercase
 */
export function answerReferencesCitation(answer, ids, titlesLowercase) {
  const text = typeof answer === "string" ? answer : "";
  if (!text.trim()) return false;
  for (const id of ids) {
    if (id && text.includes(id)) return true;
  }
  const lower = text.toLowerCase();
  for (const t of titlesLowercase) {
    if (t && lower.includes(t)) return true;
  }
  return false;
}

/**
 * Scan tool messages in the conversation for search_context payloads and check the final answer.
 * @param {string} finalAnswer
 * @param {Array<{ role?: string; content?: string; name?: string }>} messages
 */
export function checkCitationCoverage(finalAnswer, messages) {
  if (!citationsRequired()) return { ok: true, skipped: true };
  const ids = new Set();
  const titles = new Set();
  if (!Array.isArray(messages)) return { ok: true, skipped: true };

  for (const m of messages) {
    if (m && m.role === "tool" && typeof m.content === "string") {
      const t = extractCitationTargetsFromSearchResult(m.content);
      t.ids.forEach((id) => ids.add(id));
      t.titles.forEach((t) => titles.add(t));
    }
  }

  if (ids.size === 0 && titles.size === 0) {
    return { ok: true, skipped: true, reason: "no_search_context_snippets" };
  }

  const ok = answerReferencesCitation(finalAnswer, ids, titles);
  return ok
    ? { ok: true, skipped: false }
    : { ok: false, skipped: false, reason: "final_answer_missing_citation_for_retrieved_sources" };
}
