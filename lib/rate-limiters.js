import rateLimit from "express-rate-limit";

/**
 * Create the shared rate limiters used by server.js and route modules.
 *
 * Behavior-preserving factory: each limiter mirrors the instance that used to
 * live inline in server.js. The `apiError` helper is injected so error
 * responses keep the structured { error, code, hint, requestId } shape.
 *
 * @param {object} opts
 * @param {Function} opts.apiError          Structured error response helper.
 * @param {Function} opts.isAuthConfigured  Returns true when user auth is configured.
 * @param {number}   opts.RATE_LIMIT_WINDOW_MS
 * @param {number}   opts.RATE_LIMIT_MAX
 * @param {number}   opts.RATE_LIMIT_MAX_PER_USER
 * @param {number|null} opts.RATE_LIMIT_PER_KEY
 */
export function createRateLimiters({
  apiError,
  isAuthConfigured,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_PER_USER,
  RATE_LIMIT_PER_KEY,
}) {
  const perKeyChatRateLimiter =
    RATE_LIMIT_PER_KEY != null
      ? rateLimit({
          windowMs: RATE_LIMIT_WINDOW_MS,
          max: RATE_LIMIT_PER_KEY,
          standardHeaders: true,
          legacyHeaders: false,
          skip: (req) => !req.apiKeyId,
          keyGenerator: (req) => `key:${req.apiKeyId || "unknown"}`,
          handler: (req, res) => {
            apiError(res, 429, "RATE_LIMITED", "Too many requests per API key", "Reduce request rate or increase RATE_LIMIT_PER_KEY.");
          },
        })
      : (req, res, next) => next();

  const chatRateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: isAuthConfigured() ? RATE_LIMIT_MAX_PER_USER : RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (isAuthConfigured() && req.userId && req.userId !== "anonymous") {
        return `user:${req.userId}`;
      }
      return req.ip || req.socket?.remoteAddress || "unknown";
    },
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many requests", "Reduce request rate or increase RATE_LIMIT_MAX_PER_USER / RATE_LIMIT_MAX.");
    },
  });

  const integrationRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const knowledgeIndexRateLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.KNOWLEDGE_INDEX_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many index requests", "Reduce indexing rate or increase KNOWLEDGE_INDEX_RATE_LIMIT_MAX.");
    },
  });

  const embeddingsRateLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.EMBEDDINGS_RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many embeddings requests", "Reduce request rate or increase EMBEDDINGS_RATE_LIMIT_MAX.");
    },
  });

  const storageRateLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.STORAGE_RATE_LIMIT_MAX) || 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const pluginsActionsRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const marketplaceRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const webhooksRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const executeStepRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many execute requests", "Wait before retrying.");
    },
  });

  const evalRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many eval runs", "Limit: 5 runs per minute. Wait before retrying.");
    },
  });

  return {
    perKeyChatRateLimiter,
    chatRateLimiter,
    integrationRateLimiter,
    knowledgeIndexRateLimiter,
    embeddingsRateLimiter,
    storageRateLimiter,
    pluginsActionsRateLimiter,
    marketplaceRateLimiter,
    webhooksRateLimiter,
    executeStepRateLimiter,
    evalRateLimiter,
  };
}
