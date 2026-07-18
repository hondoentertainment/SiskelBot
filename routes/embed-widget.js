/**
 * Phase 79.1: Embeddable chat widget (iframe + postMessage API).
 */
import { join } from "path";

export function mountEmbedWidgetRoutes(app, deps) {
  const { apiRoute, logRequest } = deps;
  const rootDir = deps.__dirname || process.cwd();

  app.get("/embed/widget.js", logRequest, (_req, res) => {
    res.type("application/javascript");
    res.sendFile(join(rootDir, "client", "embed", "widget.js"));
  });

  app.get("/embed/frame.html", logRequest, (_req, res) => {
    res.sendFile(join(rootDir, "client", "embed", "frame.html"));
  });

  apiRoute("get", "/embed/config", logRequest, (req, res) => {
    const workspace = String(req.query?.workspace || "default").slice(0, 100);
    res.json({
      workspace,
      frameUrl: `/embed/frame.html?workspace=${encodeURIComponent(workspace)}`,
      postMessageOrigin: process.env.APP_BASE_URL || "*",
      events: ["siskelbot:ready", "siskelbot:message", "siskelbot:error", "siskelbot:resize"],
    });
  });
}
