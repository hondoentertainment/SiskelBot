/**
 * Agent Runs list view. Source: GET {apiBase}/agent/sessions.
 * Pure helpers formatStatus / sortRows / filterRows / mergeRunEvent are
 * exported for tests.
 *
 * Live updates arrive over the unified realtime WebSocket. After the
 * initial HTTP fetch populates the list we subscribe to `run:<id>` for
 * each visible session and apply `status.change` / `done` events in
 * place. A low-frequency refetch (30s or on window focus) catches new
 * sessions that didn't exist on mount.
 */

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_LIMIT = 40;
const CSS_HREF = new URL("./runs.css", import.meta.url).href;

const STATUS_META = {
  running:   { label: "Running",   cls: "runs-badge runs-badge-running" },
  paused:    { label: "Paused",    cls: "runs-badge runs-badge-paused" },
  completed: { label: "Complete",  cls: "runs-badge runs-badge-ok" },
  complete:  { label: "Complete",  cls: "runs-badge runs-badge-ok" },
  failed:    { label: "Failed",    cls: "runs-badge runs-badge-bad" },
  cancelled: { label: "Cancelled", cls: "runs-badge runs-badge-muted" },
};

/**
 * Map a status string to { label, cls } for badge rendering.
 * Exposed for tests.
 */
export function formatStatus(status) {
  const key = String(status || "").toLowerCase().trim();
  if (STATUS_META[key]) return { ...STATUS_META[key] };
  return { label: key ? key : "unknown", cls: "runs-badge runs-badge-muted" };
}

/**
 * Stable sort over a row array. `by` is one of
 * "createdAt" | "updatedAt" | "title" | "status". Default: createdAt desc.
 * Returns a new array; input is not mutated.
 */
export function sortRows(rows, by) {
  if (!Array.isArray(rows)) return [];
  const key = typeof by === "string" && by ? by : "createdAt";
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const va = pick(a.r, key);
    const vb = pick(b.r, key);
    let cmp;
    if (key === "title" || key === "status") {
      cmp = String(va || "").localeCompare(String(vb || ""));
    } else {
      // date-like: parse to ms; descending (newest first)
      const na = toMs(va);
      const nb = toMs(vb);
      cmp = nb - na;
    }
    if (cmp !== 0) return cmp;
    return a.i - b.i; // stable
  });
  return indexed.map((x) => x.r);
}

function pick(row, key) {
  if (!row) return null;
  return row[key];
}

function toMs(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Client-side filter.
 * - statusFilter: "" | "all" | one of running/paused/completed/failed/...
 * - query: substring match against title (case-insensitive); also matches id.
 */
export function filterRows(rows, opts) {
  if (!Array.isArray(rows)) return [];
  const statusFilter = String(opts?.statusFilter || "").toLowerCase().trim();
  const q = String(opts?.query || "").toLowerCase().trim();
  return rows.filter((row) => {
    if (statusFilter && statusFilter !== "all") {
      const s = String(row?.status || "").toLowerCase();
      // Treat "completed" and "complete" as equivalent.
      const norm = (x) => (x === "complete" ? "completed" : x);
      if (norm(s) !== norm(statusFilter)) return false;
    }
    if (q) {
      const hay = `${row?.title || ""} ${row?.id || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Reducer that folds a realtime `run:<id>` event into an existing row.
 *
 * Returns a NEW row object (never mutates the input) with any of
 * `status`, `updatedAt`, `eventCount` patched from the event. Unknown
 * event types are ignored (row returned unchanged). Exposed for tests.
 *
 * @param {object|null|undefined} row
 * @param {{ type?: string, payload?: any, ts?: number|string }} [event]
 */
export function mergeRunEvent(row, event) {
  if (!row || typeof row !== "object") return row;
  if (!event || typeof event !== "object") return row;
  const type = String(event.type || "").toLowerCase();
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};

  // Only `status.change` and `done` move a row forward. Other event
  // types (tool.call, tool.result, artifact.new, cost.update, etc.) are
  // timeline-level and are surfaced in the single-run view, not here.
  // We still bump `eventCount` for any known event so stale list views
  // reflect activity.
  const KNOWN = new Set([
    "status.change",
    "done",
    "tool.call",
    "tool.result",
    "plan.update",
    "hitl.request",
    "hitl.resolved",
    "artifact.new",
    "cost.update",
  ]);
  if (!KNOWN.has(type)) return row;

  const next = { ...row };
  let changed = false;

  if (type === "status.change") {
    const s = payload.status;
    if (typeof s === "string" && s && s !== row.status) {
      next.status = s;
      changed = true;
    }
  } else if (type === "done") {
    // `done` is terminal. If the payload carries a status use it;
    // otherwise fall back to `completed` unless the row is already in a
    // terminal state.
    const s = typeof payload.status === "string" && payload.status ? payload.status : null;
    if (s) {
      if (s !== row.status) { next.status = s; changed = true; }
    } else {
      const cur = String(row.status || "").toLowerCase();
      const terminal = cur === "completed" || cur === "complete" || cur === "failed" || cur === "cancelled";
      if (!terminal) { next.status = "completed"; changed = true; }
    }
  }

  const baseCount = Number(row.eventCount);
  const nextCount = Number.isFinite(baseCount) ? baseCount + 1 : 1;
  next.eventCount = nextCount;
  changed = true;

  // Touch updatedAt so sort-by-updatedAt surfaces recently-active rows.
  if (event.ts != null) {
    next.updatedAt = typeof event.ts === "number" ? new Date(event.ts).toISOString() : String(event.ts);
  } else {
    next.updatedAt = new Date().toISOString();
  }

  return changed ? next : row;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
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
  if (document.querySelector('link[data-runs-css="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.runsCss = "1";
  document.head.appendChild(link);
}

function fmtTimestamp(v) {
  if (!v) return "—";
  const n = toMs(v);
  if (!n) return String(v);
  const d = new Date(n);
  return d.toLocaleString();
}

function firstLine(s) {
  if (!s) return "";
  const line = String(s).split(/\r?\n/)[0] || "";
  return line.slice(0, 140);
}

function rowTitle(row) {
  return row?.title || firstLine(row?.planSummary) || "Untitled session";
}

function navigateToRun(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const shell = typeof window !== "undefined" ? window.SiskelbotShell : null;
    if (shell && shell.router && typeof shell.router.navigate === "function") {
      shell.router.navigate("/runs/" + id);
      return;
    }
  } catch (_) { /* fall through */ }
  if (typeof window !== "undefined") {
    window.location.assign("/app#/runs/" + id);
  }
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} root
 * @param {{
 *   params?: Record<string,string>,
 *   query?: string|URLSearchParams,
 *   apiBase?: string,
 *   refreshMs?: number,
 *   fetchImpl?: typeof fetch,
 *   workspace?: string,
 *   realtime?: { subscribe: (channel: string, handler: (ev: any) => void, opts?: object) => void, unsubscribe: (channel: string) => void } | null,
 * }} [ctx]
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export default function mount(root, ctx = {}) {
  if (!root) throw new Error("mount root required");
  const apiBase = (ctx.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const refreshMs = Math.max(5_000, Number(ctx.refreshMs) || DEFAULT_REFRESH_MS);
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const queryParams = parseQuery(ctx.query);
  const workspace = String(ctx.workspace || queryParams.get("workspace") || "default");
  const realtime = resolveRealtime(ctx.realtime);

  ensureStylesheet();

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    rows: [],
    total: 0,
    offset: 0,
    limit: DEFAULT_LIMIT,
    statusFilter: queryParams.get("status") || "all",
    query: queryParams.get("q") || "",
    loading: false,
    error: null,
    lastUpdated: null,
    destroyed: false,
  };
  let timer = null;
  /** @type {Set<string>} */
  const subscribedChannels = new Set();
  let onFocusHandler = null;

  // ── DOM scaffold ──────────────────────────────────────────────────────────
  const status = el("span", { class: "runs-pill runs-pill-loading" }, "loading…");
  const header = el("header", { class: "runs-header" }, [
    el("h1", { class: "runs-title" }, "Agent runs"),
    el("span", { class: "runs-subtitle" }, `workspace: ${workspace}`),
    status,
  ]);

  const statusSelect = el("select", { class: "runs-select", "aria-label": "Filter by status" }, [
    el("option", { value: "all" }, "All statuses"),
    el("option", { value: "running" }, "Running"),
    el("option", { value: "paused" }, "Paused"),
    el("option", { value: "completed" }, "Complete"),
    el("option", { value: "failed" }, "Failed"),
    el("option", { value: "cancelled" }, "Cancelled"),
  ]);
  statusSelect.value = state.statusFilter;
  statusSelect.addEventListener("change", () => {
    state.statusFilter = statusSelect.value;
    renderTable();
  });

  const searchInput = el("input", {
    class: "runs-search",
    type: "search",
    placeholder: "Search title or id…",
    "aria-label": "Search",
  });
  searchInput.value = state.query;
  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    renderTable();
  });

  const newBtn = el("button", { class: "runs-btn runs-btn-primary", type: "button" }, "Start a new session");
  newBtn.addEventListener("click", () => { startNewSession().catch((e) => setError(e)); });

  const refreshBtn = el("button", { class: "runs-btn", type: "button" }, "Refresh");
  refreshBtn.addEventListener("click", () => { refresh().catch(() => {}); });

  const toolbar = el("div", { class: "runs-toolbar" }, [
    statusSelect,
    searchInput,
    el("span", { class: "runs-toolbar-spacer" }),
    refreshBtn,
    newBtn,
  ]);

  const tbody = el("tbody", { class: "runs-tbody" });
  const table = el("table", { class: "runs-table" }, [
    el("thead", null, el("tr", null, [
      el("th", { scope: "col" }, "Created"),
      el("th", { scope: "col" }, "Title"),
      el("th", { scope: "col" }, "Status"),
      el("th", { scope: "col", class: "runs-num" }, "Events"),
      el("th", { scope: "col" }, ""),
    ])),
    tbody,
  ]);

  const empty = el("div", { class: "runs-empty", hidden: "hidden" });
  const errorBar = el("div", { class: "runs-error", role: "alert", hidden: "hidden" });

  const footer = el("footer", { class: "runs-footer" }, [
    el("span", { class: "runs-count" }, "—"),
    el("span", { class: "runs-hint" }, "Live via realtime channel run:<id>. Background refresh every 30s."),
  ]);

  const wrap = el("section", { class: "runs-view", "aria-labelledby": "runs-view-title" }, [
    header,
    toolbar,
    errorBar,
    table,
    empty,
    footer,
  ]);
  header.querySelector("h1").id = "runs-view-title";

  root.replaceChildren(wrap);

  // ── Rendering ─────────────────────────────────────────────────────────────
  function renderTable() {
    const filtered = filterRows(sortRows(state.rows, "createdAt"), {
      statusFilter: state.statusFilter,
      query: state.query,
    });

    tbody.replaceChildren();
    if (filtered.length === 0) {
      empty.hidden = false;
      empty.replaceChildren();
      if (state.rows.length === 0 && !state.error && !state.loading) {
        empty.appendChild(el("p", null, "No agent sessions yet in this workspace."));
        const cta = el("button", { class: "runs-btn runs-btn-primary", type: "button" }, "Start a new session");
        cta.addEventListener("click", () => { startNewSession().catch((e) => setError(e)); });
        empty.appendChild(cta);
      } else if (state.rows.length === 0 && state.error) {
        empty.appendChild(el("p", null, "No sessions available. (You may be signed out — sign in to view runs.)"));
      } else {
        empty.appendChild(el("p", null, "No sessions match the current filters."));
      }
      footer.querySelector(".runs-count").textContent = `0 of ${state.total}`;
      return;
    }
    empty.hidden = true;

    for (const row of filtered) {
      const meta = formatStatus(row.status);
      const badge = el("span", { class: meta.cls }, meta.label);
      const tr = el("tr", {
        class: "runs-row",
        tabindex: "0",
        role: "link",
        "aria-label": `Open session ${rowTitle(row)}`,
        dataset: { id: row.id },
      }, [
        el("td", { class: "runs-created" }, fmtTimestamp(row.createdAt)),
        el("td", { class: "runs-title-cell" }, rowTitle(row)),
        el("td", null, badge),
        el("td", { class: "runs-num" }, String(row.eventCount ?? row.iterations ?? 0)),
        el("td", { class: "runs-actions" }, el("a", { href: "#/runs/" + row.id, class: "runs-link" }, "Open →")),
      ]);
      tr.addEventListener("click", (e) => {
        // Don't double-navigate when the explicit link is clicked.
        if (e.target && e.target.closest && e.target.closest("a")) return;
        navigateToRun(row.id);
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigateToRun(row.id);
        }
      });
      tbody.appendChild(tr);
    }
    footer.querySelector(".runs-count").textContent = `${filtered.length} of ${state.total}`;
  }

  function setError(err) {
    state.error = err;
    if (!err) {
      errorBar.hidden = true;
      errorBar.textContent = "";
    } else {
      errorBar.hidden = false;
      errorBar.textContent = `Error: ${err.message || err}`;
    }
    renderTable();
  }

  function setStatusPill(text, cls) {
    status.textContent = text;
    status.className = "runs-pill " + cls;
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function refresh() {
    if (state.destroyed) return;
    if (!fetchImpl) {
      setError(new Error("fetch not available"));
      setStatusPill("offline", "runs-pill-bad");
      return;
    }
    state.loading = true;
    try {
      const url = `${apiBase}/agent/sessions?workspace=${encodeURIComponent(workspace)}&limit=${state.limit}&offset=${state.offset}`;
      const resp = await fetchImpl(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        // 401/403 render an empty-state rather than shouting — SPA mounts
        // before auth may be fully established.
        if (resp.status === 401 || resp.status === 403) {
          state.rows = [];
          state.total = 0;
          state.error = null;
          setStatusPill("signed out", "runs-pill-muted");
          renderTable();
          return;
        }
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      state.rows = Array.isArray(data?.items) ? data.items : [];
      state.total = Number(data?.total) || state.rows.length;
      state.error = null;
      state.lastUpdated = Date.now();
      setStatusPill(`updated ${new Date().toLocaleTimeString()}`, "runs-pill-ok");
      syncSubscriptions();
      renderTable();
    } catch (err) {
      setStatusPill("error", "runs-pill-bad");
      setError(err);
    } finally {
      state.loading = false;
    }
  }

  async function startNewSession() {
    if (!fetchImpl) throw new Error("fetch not available");
    newBtn.disabled = true;
    try {
      const resp = await fetchImpl(`${apiBase}/agent/sessions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ workspace }),
      });
      if (!resp.ok) {
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || `HTTP ${resp.status}`);
      }
      const session = await resp.json();
      if (session?.id) {
        navigateToRun(session.id);
      } else {
        await refresh();
      }
    } finally {
      newBtn.disabled = false;
    }
  }

  async function safeJson(resp) {
    try { return await resp.json(); } catch (_) { return null; }
  }

  // ── Realtime subscriptions ────────────────────────────────────────────────
  function handleRunEvent(ev) {
    if (state.destroyed) return;
    // `ev.channel` looks like "run:<sessionId>".
    const channel = ev && typeof ev === "object" ? ev.channel : null;
    if (typeof channel !== "string" || !channel.startsWith("run:")) return;
    const sessionId = channel.slice(4);
    if (!sessionId) return;

    // The server's realtime payload follows the Agent Run stream schema:
    // { type: "status.change" | "done" | ..., payload: { ... } }
    // In some deployments the whole frame IS the payload; tolerate both.
    const raw = ev.payload && typeof ev.payload === "object" ? ev.payload : ev;
    const evtShape = raw && typeof raw === "object" && typeof raw.type === "string"
      ? raw
      : { type: ev.type, payload: raw, ts: ev.ts };

    const idx = state.rows.findIndex((r) => r && r.id === sessionId);
    if (idx === -1) return; // row not in the current page; picked up on next refetch
    const next = mergeRunEvent(state.rows[idx], evtShape);
    if (next === state.rows[idx]) return;
    state.rows = state.rows.slice();
    state.rows[idx] = next;
    renderTable();
  }

  function syncSubscriptions() {
    if (!realtime || state.destroyed) return;
    const desired = new Set();
    for (const row of state.rows) {
      if (row && typeof row.id === "string" && row.id) {
        desired.add(`run:${row.id}`);
      }
    }
    // Unsubscribe channels no longer in the visible list.
    for (const ch of Array.from(subscribedChannels)) {
      if (!desired.has(ch)) {
        try { realtime.unsubscribe(ch); } catch (_) { /* ignore */ }
        subscribedChannels.delete(ch);
      }
    }
    // Subscribe any new channels.
    for (const ch of desired) {
      if (subscribedChannels.has(ch)) continue;
      try {
        realtime.subscribe(ch, handleRunEvent, { resume: true });
        subscribedChannels.add(ch);
      } catch (_) { /* ignore */ }
    }
  }

  function unsubscribeAll() {
    if (!realtime) { subscribedChannels.clear(); return; }
    for (const ch of subscribedChannels) {
      try { realtime.unsubscribe(ch); } catch (_) { /* ignore */ }
    }
    subscribedChannels.clear();
  }

  // Kick off initial fetch. syncSubscriptions() runs inside refresh() on success.
  refresh().catch(() => {});

  // Low-frequency background refetch to pick up NEW sessions that didn't
  // exist at mount time. Realtime covers updates to existing rows.
  timer = setInterval(() => { refresh().catch(() => {}); }, refreshMs);
  if (typeof timer?.unref === "function") timer.unref();

  // Also refetch when the tab regains focus — cheap and makes the list
  // feel instant after the user comes back.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    onFocusHandler = () => { refresh().catch(() => {}); };
    try { window.addEventListener("focus", onFocusHandler); } catch (_) { /* ignore */ }
  }

  return {
    refresh,
    destroy() {
      state.destroyed = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (onFocusHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        try { window.removeEventListener("focus", onFocusHandler); } catch (_) { /* ignore */ }
        onFocusHandler = null;
      }
      unsubscribeAll();
      try { root.replaceChildren(); } catch (_) { /* ignore */ }
    },
  };
}

/**
 * Pick the realtime client from the provided ctx or the global shell.
 * We do not instantiate our own WebSocket — a shared per-tab socket lives
 * on `window.SiskelbotShell.realtime`.
 */
function resolveRealtime(explicit) {
  if (explicit && typeof explicit.subscribe === "function" && typeof explicit.unsubscribe === "function") {
    return explicit;
  }
  if (typeof window === "undefined") return null;
  const shell = window.SiskelbotShell;
  const rt = shell && shell.realtime;
  if (rt && typeof rt.subscribe === "function" && typeof rt.unsubscribe === "function") {
    return rt;
  }
  return null;
}

function parseQuery(q) {
  try {
    if (!q) return new URLSearchParams();
    if (q instanceof URLSearchParams) return q;
    if (typeof q === "string") return new URLSearchParams(q.startsWith("?") ? q.slice(1) : q);
    if (typeof q === "object") return new URLSearchParams(q);
  } catch (_) { /* ignore */ }
  return new URLSearchParams();
}
