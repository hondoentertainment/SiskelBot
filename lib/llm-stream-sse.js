/**
 * Phase 86: Stream OpenAI-style chat completion chunks to client SSE (delta.content).
 * Phase 35.3: Uses lib/sse-writer.js for buffer-pooled, batched SSE writes.
 *
 * Backward compatible: callers may pass any object with a .write() method as `res`.
 * If the object exposes a node http.ServerResponse-style API we wrap it in an
 * SSEWriter; otherwise we fall back to the legacy direct-write path.
 *
 * @returns {Promise<{ fullText: string, error?: string }>}
 */

import { createSSEWriter } from "./sse-writer.js";
import { defaultChannelRegistry } from "./realtime-channels.js";

function isHttpResponseLike(res) {
  if (!res || typeof res.write !== "function") return false;
  // Heuristic: real http.ServerResponse exposes setHeader and end.
  return typeof res.setHeader === "function" && typeof res.end === "function";
}

export async function pipeLlmChatStreamToSse(res, backendFetch, url, config, body, opts = {}) {
  let fullText = "";
  // Use the optimized SSE writer for real responses; fall back to direct
  // res.write() for the test mocks that only implement .write().
  const useWriter = isHttpResponseLike(res);
  const writer = useWriter ? createSSEWriter(res) : null;
  // Additive channel publication — never breaks the SSE path if undefined/invalid.
  const conversationId =
    opts && typeof opts.conversationId === "string" && opts.conversationId ? opts.conversationId : null;
  let deltaIndex = 0;
  function publishDelta(delta) {
    if (!conversationId) return;
    try {
      defaultChannelRegistry.publish(`chat:${conversationId}`, {
        role: "assistant",
        delta,
        index: deltaIndex++,
      });
    } catch (_) {
      // never let publication failures break the SSE response
    }
  }

  function writeRaw(line) {
    if (writer) {
      // The line already contains the SSE framing ("data: ...\n\n"), so we
      // strip it here and let the writer re-add it via formatSSEEvent.
      // Easier: just pass through res.write to preserve byte-for-byte parity.
      try { res.write(line); } catch (_) {}
    } else {
      try { res.write(line); } catch (_) {}
    }
  }

  function emitDelta(content) {
    const payload = JSON.stringify({ choices: [{ delta: { content }, index: 0 }] });
    if (writer) writer.writeData(payload);
    else writeRaw(`data: ${payload}\n\n`);
    publishDelta(content);
  }

  function emitFinish(finishReason) {
    const payload = JSON.stringify({
      choices: [{ delta: {}, index: 0, finish_reason: finishReason }],
    });
    if (writer) writer.writeData(payload);
    else writeRaw(`data: ${payload}\n\n`);
  }

  function emitFullStop(content) {
    const payload = JSON.stringify({
      choices: [{ delta: { content }, index: 0, finish_reason: "stop" }],
    });
    if (writer) writer.writeData(payload);
    else writeRaw(`data: ${payload}\n\n`);
    publishDelta(content);
  }

  try {
    const response = await backendFetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!response.ok) {
      const err = await response.text();
      if (writer) writer.flush();
      return { fullText: "", error: err?.slice(0, 500) || `HTTP ${response.status}` };
    }
    if (!response.body?.getReader) {
      const data = await response.json().catch(() => ({}));
      const msg = data?.choices?.[0]?.message?.content;
      const t = typeof msg === "string" ? msg : "";
      fullText = t;
      if (t) emitFullStop(t);
      if (writer) writer.flush();
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
            emitDelta(delta);
          }
          const fr = json.choices?.[0]?.finish_reason;
          if (fr) emitFinish(fr);
        } catch (_) {}
      }
    }
    if (writer) writer.flush();
    return { fullText };
  } catch (e) {
    if (writer) {
      try { writer.flush(); } catch (_) {}
    }
    return { fullText, error: String(e?.message || e) };
  }
}
