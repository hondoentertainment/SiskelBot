/**
 * Stream tool execution events to the client via SSE.
 * Events: tool_start, tool_progress, tool_result, tool_error, agent_thinking
 * @module tool-stream
 */

/**
 * Write a single SSE event to the response. Silently ignores write failures
 * (e.g. client disconnected).
 * @param {import("express").Response} res
 * @param {object} payload
 */
function writeSSE(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {
    /* client may have disconnected */
  }
}

/**
 * Create a tool stream emitter bound to an Express SSE response.
 *
 * If `res` is null or the response is not in streaming mode (headers already
 * sent with a non-SSE content type), the returned emitter methods are no-ops.
 *
 * @param {import("express").Response | null} res
 * @returns {SiskelBot.ToolStreamEmitter}
 */
export function createToolStream(res) {
  const canWrite =
    res != null &&
    typeof res.write === "function" &&
    !res.writableEnded;

  const noop = () => {};

  if (!canWrite) {
    return {
      emitToolStart: noop,
      emitToolProgress: noop,
      emitToolResult: noop,
      emitToolError: noop,
      emitAgentThinking: noop,
    };
  }

  return {
    /**
     * Emit when a tool call begins execution.
     * @param {string} name  - tool name (e.g. "search_context")
     * @param {object} args  - parsed arguments sent by the LLM
     */
    emitToolStart(name, args) {
      writeSSE(res, {
        type: "tool_start",
        name,
        args,
        timestamp: Date.now(),
      });
    },

    /**
     * Emit incremental progress for a long-running tool.
     * @param {string} name     - tool name
     * @param {{ message?: string; percent?: number }} progress
     */
    emitToolProgress(name, progress) {
      writeSSE(res, {
        type: "tool_progress",
        name,
        message: progress?.message ?? null,
        percent: typeof progress?.percent === "number" ? progress.percent : null,
        timestamp: Date.now(),
      });
    },

    /**
     * Emit after a tool call completes successfully.
     * @param {string} name       - tool name
     * @param {object} result     - tool result payload
     * @param {number} durationMs - wall-clock execution time in ms
     */
    emitToolResult(name, result, durationMs) {
      writeSSE(res, {
        type: "tool_result",
        name,
        result,
        durationMs,
        timestamp: Date.now(),
      });
    },

    /**
     * Emit when a tool call fails.
     * @param {string} name  - tool name
     * @param {string} error - error message
     */
    emitToolError(name, error) {
      writeSSE(res, {
        type: "tool_error",
        name,
        error: typeof error === "string" ? error : String(error),
        timestamp: Date.now(),
      });
    },

    /**
     * Emit between iterations when the agent is planning its next step.
     * @param {string} message - human-readable thinking description
     */
    emitAgentThinking(message) {
      writeSSE(res, {
        type: "agent_thinking",
        message,
        timestamp: Date.now(),
      });
    },
  };
}
