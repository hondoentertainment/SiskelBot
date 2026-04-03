// Standardized error responses for API v2

/**
 * Send a v2 error response with consistent format.
 * @param {import('express').Response} res
 * @param {number} status - HTTP status code
 * @param {string} code - Machine-readable error code (e.g. "NOT_FOUND")
 * @param {string} message - Human-readable error message
 * @param {*} [details=null] - Additional error details
 */
export function apiV2Error(res, status, code, message, details = null) {
  const requestId = res.req?.requestId || "unknown";
  res.status(status).json({
    error: { code, message, details, requestId },
  });
}
