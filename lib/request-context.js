/**
 * Request context propagation via AsyncLocalStorage.
 *
 * Provides ambient access to the current request's ID, userId, and workspace
 * across async call chains without explicit parameter threading.
 * @module request-context
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export function getRequestContext() {
  return store.getStore() || {};
}

export function getRequestId() {
  return getRequestContext().requestId || "unknown";
}

export function withRequestContext(context, fn) {
  return store.run(context, fn);
}

export function requestContextMiddleware() {
  return (req, res, next) => {
    const context = {
      requestId: req.requestId,
      userId: req.userId,
      workspace: req.query?.workspace || "default",
      startTime: Date.now(),
    };
    store.run(context, () => next());
  };
}
