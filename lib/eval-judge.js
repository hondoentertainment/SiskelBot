/**
 * Phase 87: Optional LLM-as-judge for eval cases (target: "judge").
 */
export async function runEvalJudge(baseUrl, apiKey, model, assistantOutput, rubric) {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    ...(apiKey && { "x-api-key": apiKey }),
  };
  const body = {
    model: model || "gpt-4o-mini",
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You grade assistant outputs against a rubric. Reply with a single JSON object only: {\"pass\": true|false, \"reason\": \"short explanation\"}.",
      },
      {
        role: "user",
        content: `Rubric:\n${String(rubric || "").slice(0, 8000)}\n\n---\nAssistant output to evaluate:\n${String(assistantOutput || "").slice(0, 12000)}`,
      },
    ],
  };
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return { pass: false, reason: `Judge HTTP ${r.status}: ${text.slice(0, 200)}` };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { pass: false, reason: "Judge response not JSON" };
    }
    const content = data?.choices?.[0]?.message?.content ?? "";
    const raw = typeof content === "string" ? content.trim() : "";
    let parsed;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch {
      return { pass: false, reason: "Judge did not return parseable JSON" };
    }
    return { pass: !!parsed.pass, reason: String(parsed.reason || "") };
  } catch (e) {
    return { pass: false, reason: String(e.message || e) };
  }
}
