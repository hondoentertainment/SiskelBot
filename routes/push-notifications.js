/**
 * Phase 37.3: Push notification routes.
 *
 *   GET    /api/v1/push/vapid-key              — public VAPID key (no auth)
 *   POST   /api/v1/push/subscribe              — register subscription
 *   DELETE /api/v1/push/subscribe/:id          — unregister
 *   GET    /api/v1/push/subscriptions          — list user's subscriptions
 *   POST   /api/v1/push/send                   — send notification (self or admin)
 *   GET    /api/v1/push/preferences            — get preferences
 *   PUT    /api/v1/push/preferences            — update preferences
 *   POST   /api/v1/push/topics/:topic/subscribe
 *   DELETE /api/v1/push/topics/:topic/subscribe
 */
import {
  registerSubscription,
  unregisterSubscription,
  listUserSubscriptions,
  sendPush,
  sendBulkPush,
  publishToTopic,
  getNotificationPreferences,
  setNotificationPreferences,
  subscribeToTopic,
  unsubscribeFromTopic,
} from "../lib/push-service.js";
import { getVapidPublicKey } from "../lib/vapid-keys.js";

export function mountPushNotificationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    adminAuth,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const requireUser = userAuth || ((req, res, next) => { req.userId = req.userId || "anonymous"; next(); });

  // GET /api/v1/push/vapid-key — public so clients can subscribe before login
  apiRoute("get", "/push/vapid-key", limiter, async (req, res) => {
    try {
      const publicKey = await getVapidPublicKey();
      res.json({ _version: 1, publicKey });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/push/subscribe
  apiRoute("post", "/push/subscribe", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const { platform, token, subscription, metadata } = req.body || {};
      // Accept either { platform, token } or { platform: 'web', subscription: {...} }
      const tokenValue = token || subscription;
      const record = await registerSubscription(userId, { platform, token: tokenValue, metadata });
      res.status(201).json({ _version: 1, ...record });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /api/v1/push/subscribe/:id
  apiRoute("delete", "/push/subscribe/:id", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const result = await unregisterSubscription(req.params.id, userId);
      if (!result.removed) {
        return apiError(res, 404, "NOT_FOUND", "subscription not found");
      }
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/push/subscriptions
  apiRoute("get", "/push/subscriptions", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const subs = await listUserSubscriptions(userId);
      res.json({ _version: 1, subscriptions: subs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/push/send — send to self, or if admin to any user/bulk/topic
  apiRoute("post", "/push/send", limiter, requireUser, async (req, res) => {
    try {
      const callerId = req.userId || "anonymous";
      const isAdmin = Boolean(req.isAdmin) || Boolean(req.authenticatedViaDeploymentKey);
      const { userId, userIds, topic, notification } = req.body || {};

      if (!notification || typeof notification !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "notification object is required");
      }

      if (topic) {
        if (!isAdmin) return apiError(res, 403, "FORBIDDEN", "topic publish requires admin");
        const result = await publishToTopic(topic, notification);
        return res.json({ _version: 1, ...result });
      }

      if (Array.isArray(userIds) && userIds.length > 0) {
        if (!isAdmin) return apiError(res, 403, "FORBIDDEN", "bulk send requires admin");
        const result = await sendBulkPush(userIds, notification);
        return res.json({ _version: 1, ...result });
      }

      const target = userId || callerId;
      if (target !== callerId && !isAdmin) {
        return apiError(res, 403, "FORBIDDEN", "cannot send to another user without admin");
      }
      const result = await sendPush(target, notification);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/push/preferences
  apiRoute("get", "/push/preferences", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const prefs = await getNotificationPreferences(userId);
      res.json({ _version: 1, ...prefs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/push/preferences
  apiRoute("put", "/push/preferences", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const prefs = await setNotificationPreferences(userId, req.body || {});
      res.json({ _version: 1, ...prefs });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/push/topics/:topic/subscribe
  apiRoute("post", "/push/topics/:topic/subscribe", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const result = await subscribeToTopic(userId, req.params.topic);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /api/v1/push/topics/:topic/subscribe
  apiRoute("delete", "/push/topics/:topic/subscribe", limiter, requireUser, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const result = await unsubscribeFromTopic(userId, req.params.topic);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountPushNotificationRoutes;
