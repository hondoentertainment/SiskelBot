export function errorMiddleware(req, res, _next) {
  // 404 handler for unmatched routes
  if (!res.headersSent) {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND", hint: "Check the API docs at /api/docs" });
  }
}

export function errorHandler(err, req, res, next) {
  const requestId = req.requestId || req.headers?.["x-request-id"] || "unknown";
  console.error(`[error] ${req.method} ${req.path} requestId=${requestId}:`, err.message || err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || "Internal server error",
    code: err.code || "INTERNAL_ERROR",
    requestId,
    hint: "See docs/RUNBOOK.md for troubleshooting.",
  });
}
