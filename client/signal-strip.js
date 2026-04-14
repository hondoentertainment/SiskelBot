/**
 * Signal strip: small status bar rendered under the chat composer.
 *
 * Surfaces: backend + model, rolling cost estimate, p50 latency,
 * quality score, and circuit-breaker state. Polls GET /api/v1/signals/composer
 * every 10 seconds.
 *
 * Loaded as a module from client/index.html. No build step.
 */

const ENDPOINT = "/api/v1/signals/composer";
const POLL_MS = 10_000;

/**
 * Format helpers extracted for unit testing. They are intentionally pure —
 * no DOM access, no global state.
 */
export const format = {
  cost(estCostUsd) {
    const n = Number(estCostUsd);
    if (!Number.isFinite(n) || n <= 0) return "$0.000";
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(3)}`;
  },
  latency(p50LatencyMs) {
    const n = Number(p50LatencyMs);
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
    return `${Math.round(n)}ms`;
  },
  quality(qualityScore) {
    const n = Number(qualityScore);
    if (!Number.isFinite(n) || n <= 0) return "0/5★";
    const clamped = Math.max(0, Math.min(1, n));
    const stars = Math.round(clamped * 5);
    return `${stars}/5★`;
  },
  backendModel(backend, model) {
    const b = backend ? String(backend) : "unknown";
    const m = model ? String(model) : "—";
    return `${b} · ${m}`;
  },
  breaker(state) {
    if (state === "open") return { label: "degraded", degraded: true };
    if (state === "half_open") return { label: "recovering", degraded: true };
    return { label: "healthy", degraded: false };
  },
};

function injectStyles() {
  if (document.getElementById("signal-strip-styles")) return;
  const style = document.createElement("style");
  style.id = "signal-strip-styles";
  style.textContent = `
    .signal-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 0.75rem;
      align-items: center;
      padding: 0.35rem 0.6rem;
      margin: 0.35rem 0;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #94a3b8;
      font-size: 0.75rem;
      line-height: 1.2;
      font-family: inherit;
    }
    .signal-strip[hidden] { display: none; }
    .signal-strip .signal-item {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      white-space: nowrap;
    }
    .signal-strip .signal-label {
      color: #64748b;
      text-transform: uppercase;
      font-size: 0.65rem;
      letter-spacing: 0.03em;
    }
    .signal-strip .signal-value {
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    .signal-strip .signal-pip {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #22c55e;
      display: inline-block;
    }
    .signal-strip .signal-pip.signal-pip-degraded {
      background: #eab308;
      box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.2);
    }
    .signal-strip .signal-warning {
      color: #eab308;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
}

function findAnchor() {
  // Primary selector called out in the spec; fall back to the actual
  // composer textarea used by client/index.html.
  return (
    document.querySelector("form#chat-form") ||
    document.getElementById("prompt") ||
    document.querySelector("textarea[aria-label='Message input']")
  );
}

function buildStrip() {
  const el = document.createElement("div");
  el.className = "signal-strip";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-label", "Live model signals");
  el.innerHTML = `
    <span class="signal-item" data-slot="backend">
      <span class="signal-label">Model</span>
      <span class="signal-value" data-field="backendModel">—</span>
    </span>
    <span class="signal-item" data-slot="cost">
      <span class="signal-label">Est. cost</span>
      <span class="signal-value" data-field="cost">$0.000</span>
    </span>
    <span class="signal-item" data-slot="latency">
      <span class="signal-label">p50</span>
      <span class="signal-value" data-field="latency">—</span>
    </span>
    <span class="signal-item" data-slot="quality">
      <span class="signal-label">Quality</span>
      <span class="signal-value" data-field="quality">0/5★</span>
    </span>
    <span class="signal-item" data-slot="breaker">
      <span class="signal-pip" data-field="pip"></span>
      <span class="signal-value" data-field="breaker">healthy</span>
    </span>
  `;
  return el;
}

function applySnapshot(stripEl, snapshot) {
  if (!stripEl || !snapshot) return;
  const setField = (name, text) => {
    const target = stripEl.querySelector(`[data-field="${name}"]`);
    if (target) target.textContent = text;
  };
  setField("backendModel", format.backendModel(snapshot.backend, snapshot.model));
  setField("cost", format.cost(snapshot.estCostUsd));
  setField("latency", format.latency(snapshot.p50LatencyMs));
  setField("quality", format.quality(snapshot.qualityScore));
  const breaker = format.breaker(snapshot.breakerState);
  setField("breaker", breaker.label);
  const pip = stripEl.querySelector('[data-field="pip"]');
  if (pip) {
    pip.classList.toggle("signal-pip-degraded", !!breaker.degraded);
    pip.title = breaker.label;
  }
  const breakerItem = stripEl.querySelector('[data-slot="breaker"] .signal-value');
  if (breakerItem) {
    breakerItem.classList.toggle("signal-warning", !!breaker.degraded);
  }
}

async function fetchSnapshot() {
  const res = await fetch(ENDPOINT, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`signals request failed: ${res.status}`);
  return res.json();
}

async function refresh(stripEl) {
  try {
    const snapshot = await fetchSnapshot();
    applySnapshot(stripEl, snapshot);
  } catch (err) {
    // Silent degrade — the last-good values stay on screen.
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[signal-strip] refresh failed:", err?.message || err);
    }
  }
}

function mount() {
  if (typeof document === "undefined") return null;
  const anchor = findAnchor();
  if (!anchor) return null;

  injectStyles();
  const stripEl = buildStrip();
  anchor.parentNode.insertBefore(stripEl, anchor);

  refresh(stripEl);
  const timer = setInterval(() => refresh(stripEl), POLL_MS);

  window.addEventListener("beforeunload", () => clearInterval(timer));
  return stripEl;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
}

export { mount };
