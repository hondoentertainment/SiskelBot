/**
 * In-app observability view — 4-card dashboard for non-ops users.
 *
 * Cards:
 *   ┌── Breakers ──────────┬── Slow Routes ───────┐
 *   ├── Trajectories ──────┼── Pool & Rates ──────┤
 *   └──────────────────────┴──────────────────────┘
 *
 * Polls GET {apiBase}/observability/snapshot every 5 seconds.
 *
 * Usage:
 *   import mount from "/client/src/views/observability.js";
 *   const view = mount(document.getElementById("root"));
 *   // later:
 *   view.destroy();
 *
 * The pure formatting helpers (`formatDuration`, `formatBreakerRow`,
 * `sortBySlowest`) are exported separately so they can be unit-tested
 * without JSDOM.
 */

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_POLL_MS = 5000;
const SLOW_ROUTE_P95_THRESHOLD_MS = 500;
const CSS_HREF = new URL("./observability.css", import.meta.url).href;

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Format a duration in milliseconds as a compact human-readable string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1) return "<1ms";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const mins = Math.floor(v / 60_000);
  const secs = Math.round((v % 60_000) / 1000);
  return `${mins}m${secs ? ` ${secs}s` : ""}`;
}

/**
 * Build the display-ready row for a breaker. Keeps pure formatting out of
 * the DOM layer so tests can assert on it directly.
 * @param {{ name: string, state: string, failures?: number, lastFailureAt?: string|null }} b
 * @returns {{ name: string, state: string, failures: number, lastFailureAt: string, isOpen: boolean }}
 */
export function formatBreakerRow(b) {
  const state = String(b?.state || "unknown").toLowerCase();
  const isOpen = state === "open";
  return {
    name: String(b?.name || "unknown"),
    state,
    failures: Number(b?.failures || 0),
    lastFailureAt: b?.lastFailureAt ? String(b.lastFailureAt) : "—",
    isOpen,
  };
}

/**
 * Sort a list of slow routes by p95 descending, falling back to hits on
 * ties. Returns a new array; input is not mutated.
 * @param {Array<{ route: string, p95Ms?: number, p50Ms?: number, hits?: number }>} rows
 * @returns {Array<object>}
 */
export function sortBySlowest(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const p = Number(b?.p95Ms || 0) - Number(a?.p95Ms || 0);
    if (p !== 0) return p;
    return Number(b?.hits || 0) - Number(a?.hits || 0);
  });
  return list;
}

// ─── DOM layer ─────────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else node.setAttribute(k, String(v));
    }
  }
  if (children != null) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-observability-css="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.observabilityCss = "1";
  document.head.appendChild(link);
}

function makeCard(title, body) {
  return el("section", { class: "obs-card" }, [
    el("header", { class: "obs-card-head" }, title),
    el("div", { class: "obs-card-body" }, body),
  ]);
}

function renderBreakers(tbody, breakers) {
  tbody.replaceChildren();
  const rows = Array.isArray(breakers) ? breakers : [];
  if (!rows.length) {
    tbody.appendChild(el("tr", null, el("td", { colspan: "4", class: "obs-empty" }, "No breakers registered.")));
    return;
  }
  for (const raw of rows) {
    const b = formatBreakerRow(raw);
    const stateCell = el(
      "td",
      { class: b.isOpen ? "obs-cell-bad" : "obs-cell-ok" },
      b.state,
    );
    tbody.appendChild(
      el("tr", null, [
        el("td", null, b.name),
        stateCell,
        el("td", null, String(b.failures)),
        el("td", null, b.lastFailureAt),
      ]),
    );
  }
}

function renderSlowRoutes(tbody, routes) {
  tbody.replaceChildren();
  const rows = sortBySlowest(routes);
  if (!rows.length) {
    tbody.appendChild(el("tr", null, el("td", { colspan: "4", class: "obs-empty" }, "No traffic recorded yet.")));
    return;
  }
  for (const r of rows) {
    const p95 = Number(r.p95Ms || 0);
    const p95Cell = el(
      "td",
      { class: p95 > SLOW_ROUTE_P95_THRESHOLD_MS ? "obs-cell-bad" : "obs-cell-ok" },
      formatDuration(p95),
    );
    tbody.appendChild(
      el("tr", null, [
        el("td", null, String(r.route)),
        p95Cell,
        el("td", null, formatDuration(Number(r.p50Ms || 0))),
        el("td", null, String(r.hits || 0)),
      ]),
    );
  }
}

function renderTrajectories(tbody, trajectories) {
  tbody.replaceChildren();
  const rows = Array.isArray(trajectories) ? trajectories : [];
  if (!rows.length) {
    tbody.appendChild(el("tr", null, el("td", { colspan: "4", class: "obs-empty" }, "No recent agent runs.")));
    return;
  }
  for (const t of rows) {
    const status = String(t.status || "unknown").toLowerCase();
    const statusClass =
      status === "error" || status === "failed" || status === "stagnated"
        ? "obs-cell-bad"
        : status === "complete" || status === "done"
          ? "obs-cell-ok"
          : "";
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "obs-mono" }, String(t.runId || "—")),
        el("td", null, t.startedAt ? new Date(t.startedAt).toLocaleString() : "—"),
        el("td", null, String(t.steps || 0)),
        el("td", { class: statusClass }, status),
      ]),
    );
  }
}

function renderPool(tbody, pool, rates, uptimeSec) {
  tbody.replaceChildren();
  const p = pool || {};
  const waiting = Number(p.waiting || 0);
  const waitingClass = waiting > 0 ? "obs-cell-bad" : "obs-cell-ok";
  const errs = Number(rates?.errorsPerMinute || 0);
  const errClass = errs > 0 ? "obs-cell-bad" : "obs-cell-ok";
  const rows = [
    ["DB connections", String(p.dbConnections || 0), ""],
    ["In use", String(p.inUse || 0), ""],
    ["Waiting", String(waiting), waitingClass],
    ["Requests / min", String(rates?.requestsPerMinute ?? 0), ""],
    ["Errors / min", String(errs), errClass],
    ["Uptime", formatDuration((Number(uptimeSec) || 0) * 1000), ""],
  ];
  for (const [label, value, cls] of rows) {
    tbody.appendChild(
      el("tr", null, [
        el("td", null, label),
        el("td", { class: cls || null }, value),
      ]),
    );
  }
}

function makeTable(head) {
  const thead = el("thead", null, el("tr", null, head.map((h) => el("th", null, h))));
  const tbody = el("tbody");
  const table = el("table", { class: "obs-table" }, [thead, tbody]);
  return { table, tbody };
}

/**
 * @param {HTMLElement} root
 * @param {{ apiBase?: string, pollMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export default function mount(root, opts = {}) {
  if (!root) throw new Error("mount root required");
  const apiBase = (opts.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const pollMs = Math.max(1000, Number(opts.pollMs) || DEFAULT_POLL_MS);
  const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  ensureStylesheet();

  const status = el("span", { class: "obs-pill obs-pill-loading" }, "loading");
  const header = el("header", { class: "obs-header" }, [
    el("h2", { class: "obs-title" }, "Observability"),
    status,
  ]);

  const breakersTable = makeTable(["Backend", "State", "Failures", "Last failure"]);
  const slowTable = makeTable(["Route", "p95", "p50", "Hits"]);
  const trajTable = makeTable(["Run ID", "Started", "Steps", "Status"]);
  const poolTable = makeTable(["Metric", "Value"]);

  const grid = el("div", { class: "obs-grid" }, [
    makeCard("Breakers", breakersTable.table),
    makeCard("Slow Routes", slowTable.table),
    makeCard("Recent Trajectories", trajTable.table),
    makeCard("Pool & Rates", poolTable.table),
  ]);

  const wrap = el("div", { class: "obs-view" }, [header, grid]);
  root.replaceChildren(wrap);

  let timer = null;
  let destroyed = false;

  async function refresh() {
    if (destroyed) return;
    try {
      if (!fetchImpl) throw new Error("fetch not available");
      const resp = await fetchImpl(`${apiBase}/observability/snapshot`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        status.textContent = `error ${resp.status}`;
        status.className = "obs-pill obs-pill-bad";
        return;
      }
      const data = await resp.json();
      renderBreakers(breakersTable.tbody, data.breakers);
      renderSlowRoutes(slowTable.tbody, data.slowRoutes);
      renderTrajectories(trajTable.tbody, data.recentTrajectories);
      renderPool(
        poolTable.tbody,
        data.pool,
        { requestsPerMinute: data.requestsPerMinute, errorsPerMinute: data.errorsPerMinute },
        data.uptimeSec,
      );
      status.textContent = `updated ${new Date().toLocaleTimeString()}`;
      status.className = "obs-pill obs-pill-ok";
    } catch (err) {
      status.textContent = `error: ${err?.message || "fetch failed"}`;
      status.className = "obs-pill obs-pill-bad";
    }
  }

  refresh();
  timer = setInterval(refresh, pollMs);

  return {
    refresh,
    destroy() {
      destroyed = true;
      if (timer) clearInterval(timer);
      timer = null;
      try { root.replaceChildren(); } catch (_) {}
    },
  };
}
