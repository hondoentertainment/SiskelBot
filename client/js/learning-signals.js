/**
 * Client-side continuous learning signals.
 * Tracks copy, share, dwell, regenerate, thumbs up/down events on assistant
 * messages and POSTs them to /api/v1/learning/interactions/:id/signal.
 *
 * Assistant messages must carry a `data-interaction-id` attribute so the
 * signals can be attributed. The active workspace is read from
 * `window.SISKEL_WORKSPACE` if set, otherwise "default".
 */

const SIGNAL_ENDPOINT = "/api/v1/learning/interactions";
const DEFAULT_WORKSPACE = "default";

let initialized = false;
const dwellTimers = new WeakMap();

function getWorkspace() {
  return (typeof window !== "undefined" && window.SISKEL_WORKSPACE) || DEFAULT_WORKSPACE;
}

function getAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const key = window.SISKEL_API_KEY || localStorage.getItem("api_key");
    if (key) headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

async function sendSignal(interactionId, type, value) {
  if (!interactionId) return;
  try {
    const ws = encodeURIComponent(getWorkspace());
    await fetch(`${SIGNAL_ENDPOINT}/${encodeURIComponent(interactionId)}/signal?workspace=${ws}`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ type, value, workspace: getWorkspace() }),
      keepalive: true,
    });
  } catch {
    // swallow — signals are best-effort
  }
}

function findInteractionId(node) {
  let el = node;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.interactionId) return el.dataset.interactionId;
    el = el.parentElement;
  }
  return null;
}

function handleCopy(event) {
  const selection = event.target?.ownerDocument?.getSelection?.();
  if (!selection || !selection.anchorNode) return;
  const id = findInteractionId(selection.anchorNode);
  if (id) sendSignal(id, "copy");
}

function handleClick(event) {
  const target = event.target;
  if (!target || !target.matches) return;
  if (target.matches("[data-thumb-up]")) {
    const id = findInteractionId(target);
    if (id) sendSignal(id, "rating", 1);
  } else if (target.matches("[data-thumb-down]")) {
    const id = findInteractionId(target);
    if (id) sendSignal(id, "rating", -1);
  } else if (target.matches("[data-regenerate]")) {
    const id = findInteractionId(target);
    if (id) sendSignal(id, "regenerate");
  } else if (target.matches("[data-share]")) {
    const id = findInteractionId(target);
    if (id) sendSignal(id, "share");
  }
}

function startDwellTracking(el) {
  if (!el || dwellTimers.has(el)) return;
  dwellTimers.set(el, Date.now());
}

function flushDwell(el) {
  const start = dwellTimers.get(el);
  if (!start) return;
  const ms = Date.now() - start;
  dwellTimers.delete(el);
  const id = el?.dataset?.interactionId;
  if (id && ms >= 500) sendSignal(id, "dwell", ms);
}

function observeAssistantMessages() {
  if (typeof IntersectionObserver === "undefined") return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) startDwellTracking(entry.target);
      else flushDwell(entry.target);
    }
  }, { threshold: 0.5 });

  const mo = new MutationObserver(() => {
    document.querySelectorAll("[data-interaction-id]:not([data-cl-observed])").forEach((el) => {
      el.setAttribute("data-cl-observed", "1");
      io.observe(el);
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

/**
 * Initialize client-side learning signal capture.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initLearningSignals() {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  document.addEventListener("copy", handleCopy, true);
  document.addEventListener("click", handleClick, true);
  window.addEventListener("beforeunload", () => {
    document.querySelectorAll("[data-interaction-id]").forEach(flushDwell);
  });
  observeAssistantMessages();
}

export function recordManualSignal(interactionId, type, value) {
  return sendSignal(interactionId, type, value);
}

// Auto-init when loaded as a module from HTML.
if (typeof document !== "undefined" && document.readyState !== "loading") {
  initLearningSignals();
} else if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initLearningSignals);
}
