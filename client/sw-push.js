/**
 * Phase 37.3: Service worker push handler.
 *
 * Handles incoming Web Push messages and routes notification click events.
 * Include from the main service worker via `importScripts('/sw-push.js')`
 * or register this file as its own service worker if you prefer to keep
 * push delivery isolated from the app-shell cache logic.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch (_) {
    data = { title: "Notification", body: event.data?.text?.() || "" };
  }

  const title = data.title || "SiskelBot";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon.svg",
    badge: data.badge || "/icon.svg",
    data: data.data || {},
    tag: data.tag,
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
    actions: Array.isArray(data.actions) ? data.actions : undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || "/";

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        const target = new URL(targetUrl, self.location.origin);
        if (clientUrl.pathname === target.pathname) {
          await client.focus();
          client.postMessage({ type: "notificationclick", data });
          return;
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // When the browser rotates the subscription, re-register with the server.
  event.waitUntil((async () => {
    try {
      const newSub = event.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
      });
      await fetch("/api/v1/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "web", subscription: newSub.toJSON ? newSub.toJSON() : newSub }),
        credentials: "include",
      });
    } catch (err) {
      // Best-effort; swallow errors to avoid crashing the worker.
      console.warn("[sw-push] pushsubscriptionchange failed:", err?.message);
    }
  })());
});
