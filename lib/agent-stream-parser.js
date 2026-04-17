/**
 * Reusable async generator that parses an OpenAI-compatible SSE ReadableStream
 * into typed chunks for the agent loop.
 *
 * Yields:
 *   { type: "delta", content: string, index: number }
 *   { type: "tool_call_delta", index: number, id?: string, name?: string, arguments_delta: string }
 *   { type: "usage", prompt_tokens: number, completion_tokens: number, total_tokens: number }
 *   { type: "done" }
 *
 * @module agent-stream-parser
 */

/**
 * @param {Response} response - A fetch Response whose body is an SSE stream.
 * @yields {object} Typed chunks as described above.
 */
export async function* parseCompletionStream(response) {
  const body = response.body;
  if (!body) {
    yield { type: "done" };
    return;
  }

  // Support both web ReadableStream (.getReader) and Node Readable (async iterable).
  const chunks = body[Symbol.asyncIterator]
    ? body
    : readableStreamToAsyncIterable(body);

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const raw of chunks) {
    // raw may be a Uint8Array or a string depending on the source.
    buffer += typeof raw === "string" ? raw : decoder.decode(raw, { stream: true });

    const lines = buffer.split("\n");
    // The last element may be an incomplete line; keep it in the buffer.
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, comments, and lines without the data: prefix.
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();

      if (payload === "[DONE]") {
        yield { type: "done" };
        return;
      }

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        // Malformed JSON -- skip gracefully.
        continue;
      }

      // Emit usage if present (OpenAI sends this on the final chunk when
      // stream_options.include_usage is set; vLLM may include it on every chunk).
      if (json.usage && typeof json.usage === "object") {
        yield {
          type: "usage",
          prompt_tokens: Number(json.usage.prompt_tokens) || 0,
          completion_tokens: Number(json.usage.completion_tokens) || 0,
          total_tokens: Number(json.usage.total_tokens) || 0,
        };
      }

      const choices = json.choices;
      if (!Array.isArray(choices)) continue;

      for (const choice of choices) {
        const delta = choice.delta;
        if (!delta || typeof delta !== "object") continue;
        const choiceIndex = Number(choice.index) || 0;

        // Text content delta
        if (typeof delta.content === "string") {
          yield { type: "delta", content: delta.content, index: choiceIndex };
        }

        // Tool call deltas
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc.index) || 0;
            yield {
              type: "tool_call_delta",
              index: idx,
              ...(tc.id ? { id: tc.id } : {}),
              ...(tc.function?.name ? { name: tc.function.name } : {}),
              arguments_delta: tc.function?.arguments || "",
            };
          }
        }
      }
    }
  }

  // Stream ended without [DONE] -- still emit done for clean termination.
  yield { type: "done" };
}

/**
 * Convert a web ReadableStream into an async iterable.
 * @param {ReadableStream} stream
 */
async function* readableStreamToAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
