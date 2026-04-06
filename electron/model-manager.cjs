/**
 * Phase 106 — Local model manager.
 *
 * Express routes for managing Ollama models from the desktop app:
 *   GET  /api/desktop/models       — list installed models
 *   POST /api/desktop/models/pull  — pull a model (streams progress via SSE)
 *   DELETE /api/desktop/models/:name — delete a model
 *
 * These routes are only registered when ELECTRON_DESKTOP=1.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/**
 * Register desktop model-manager routes on the Express app.
 *
 * @param {import('express').Express} expressApp
 */
function registerModelRoutes(expressApp) {
  // Guard: only available in desktop mode
  if (process.env.ELECTRON_DESKTOP !== "1") return;

  // GET /api/desktop/models — list installed Ollama models
  expressApp.get("/api/desktop/models", async (_req, res) => {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        return res.status(502).json({
          error: `Ollama returned ${resp.status}`,
          hint: "Is Ollama running? Try: ollama serve",
        });
      }

      const data = await resp.json();
      const models = (data.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        quantization: m.details?.quantization_level || null,
        family: m.details?.family || null,
        parameter_size: m.details?.parameter_size || null,
        modified_at: m.modified_at || null,
        digest: m.digest || null,
      }));

      res.json({ models });
    } catch (e) {
      if (e.name === "TimeoutError" || e.code === "UND_ERR_CONNECT_TIMEOUT") {
        return res.status(504).json({
          error: "Ollama not reachable",
          hint: "Is Ollama running? Try: ollama serve",
        });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/desktop/models/pull — pull a model with SSE progress
  expressApp.post("/api/desktop/models/pull", async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing model name" });
    }

    // Sanitize model name (alphanumeric, colons, slashes, dots, hyphens)
    if (!/^[\w./:@-]+$/.test(name)) {
      return res.status(400).json({ error: "Invalid model name" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const resp = await fetch(`${OLLAMA_URL}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stream: true }),
      });

      if (!resp.ok) {
        res.write(`data: ${JSON.stringify({ error: `Ollama returned ${resp.status}` })}\n\n`);
        res.end();
        return;
      }

      const reader = resp.body;
      if (!reader) {
        res.write(`data: ${JSON.stringify({ error: "No response body" })}\n\n`);
        res.end();
        return;
      }

      // Stream NDJSON from Ollama as SSE
      let buffer = "";
      reader.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch (_) {
            /* skip non-JSON */
          }
        }
      });

      reader.on("end", () => {
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer);
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch (_) {
            /* skip */
          }
        }
        res.write(`data: ${JSON.stringify({ status: "done" })}\n\n`);
        res.end();
      });

      reader.on("error", (err) => {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      });

      // Handle client disconnect
      req.on("close", () => {
        try { reader.destroy(); } catch (_) { /* ignore */ }
      });
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  });

  // DELETE /api/desktop/models/:name — delete a model
  expressApp.delete("/api/desktop/models/:name", async (req, res) => {
    const { name } = req.params;
    if (!name) {
      return res.status(400).json({ error: "Missing model name" });
    }

    try {
      const resp = await fetch(`${OLLAMA_URL}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return res.status(resp.status).json({
          error: `Ollama returned ${resp.status}`,
          detail: text,
        });
      }

      res.json({ deleted: name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerModelRoutes };
