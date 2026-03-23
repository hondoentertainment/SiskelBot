/**
 * Phase 86: Stream OpenAI-style chat completion chunks to client SSE (delta.content).
 * @returns {Promise<{ fullText: string, error?: string }>}
 */
export async function pipeLlmChatStreamToSse(res, backendFetch, url, config, body) {
  let fullText = "";
  try {
    const response = await backendFetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!response.ok) {
      const err = await response.text();
      return { fullText: "", error: err?.slice(0, 500) || `HTTP ${response.status}` };
    }
    if (!response.body?.getReader) {
      const data = await response.json().catch(() => ({}));
      const msg = data?.choices?.[0]?.message?.content;
      const t = typeof msg === "string" ? msg : "";
      fullText = t;
      if (t) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: t }, index: 0, finish_reason: "stop" }] })}\n\n`
        );
      }
      return { fullText };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`
            );
          }
          const fr = json.choices?.[0]?.finish_reason;
          if (fr) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: fr }] })}\n\n`
            );
          }
        } catch (_) {}
      }
    }
    return { fullText };
  } catch (e) {
    return { fullText, error: String(e?.message || e) };
  }
}
