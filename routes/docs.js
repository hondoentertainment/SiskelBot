import express from "express";

export default function mountDocsRoutes(app, deps) {
  const { openApiSpec } = deps;

  app.get("/api/docs/openapi.json", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.json(openApiSpec);
  });

  app.get("/docs", (req, res) => res.redirect(302, "/api/docs"));
  app.get("/api/docs", (req, res) => {
    const base = req.protocol + "//" + (req.get("host") || "localhost");
    const specUrl = base + "/api/docs/openapi.json";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Siskel Bot API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    });
  </script>
</body>
</html>`);
  });
}
