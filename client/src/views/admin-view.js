/**
 * Admin dashboard view for the SiskelBot SPA shell (read-only).
 *
 * WIRING — app.js should register this view like so:
 *   router.register("/admin", mountInto(() => import("./views/admin-view.js")));
 * (Replace any existing placeholderView("Admin", ...) entry.)
 *
 * Tabs rendered:
 *   1. Workspaces — derived from GET /api/admin/summary (workspaces + quota usage)
 *   2. Users      — derived from GET /api/admin/summary (users array)
 *   3. Audit      — GET /api/admin/audit/query?limit=50 (paged entries)
 *   4. System     — derived from GET /api/admin/summary (system block + usage)
 *
 * Every endpoint is admin-scoped. 401/403 surface a "You need admin access"
 * panel in place of the tab body; the legacy /admin page keeps the API-key
 * login flow for mutating operations (revoke key, set quota, archive now).
 *
 * Pure helpers (formatAuditEntry, summarizeWorkspace, redactSensitive,
 * formatRelativeTime) are exported for JSDOM-free unit tests.
 */

const DEFAULT_API_BASE = "";
const DEFAULT_WORKSPACE = "default";
const AUDIT_PAGE_SIZE = 50;
const CSS_HREF = new URL("./admin-view.css", import.meta.url).href;

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Normalize an audit entry into a display-safe row with defaults. Does not
 * mutate the input. Unknown/missing fields collapse to short placeholders.
 */
export function formatAuditEntry(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const ts = typeof e.timestamp === "string" ? e.timestamp : "";
  const okRaw = e.ok;
  const ok = okRaw === false ? false : Boolean(okRaw ?? true);
  return {
    timestamp: ts ? ts.slice(0, 19).replace("T", " ") : "—",
    action: String(e.action || "—"),
    userId: String(e.userId || e.user || "—"),
    workspaceId: String(e.workspaceId || e.workspace || "—"),
    ok,
    status: ok ? "OK" : "FAIL",
    details: redactSensitive(String(e.error || e.result || e.details || "")),
  };
}

/**
 * Summarize a workspace row from the admin summary payload. Produces a stable
 * shape suited for table rendering. Pure — input is not mutated.
 */
export function summarizeWorkspace(ws) {
  const w = ws && typeof ws === "object" ? ws : {};
  const used = Number(w.tokensUsed ?? 0);
  const rawLimit = w.override ?? w.quota?.limit ?? 0;
  const limit = Number(rawLimit) || 0;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return {
    userId: String(w.userId || "—"),
    workspaceId: String(w.workspaceId || "default"),
    workspaceName: String(w.workspaceName || w.workspaceId || "default"),
    tokensUsed: Number.isFinite(used) ? used : 0,
    limit,
    pct,
    hasOverride: w.override != null,
  };
}

/**
 * Mask anything that looks like an API key, bearer token, or email address
 * inside an audit/error string. Pure — returns a new string.
 */
export function redactSensitive(str) {
  if (str == null) return "";
  let s = String(str);
  // Bearer / API-key prefixes
  s = s.replace(/\b(sk|pk|api|bearer)[-_][A-Za-z0-9]{8,}/gi, (m) => {
    const prefix = m.split(/[-_]/)[0];
    return `${prefix}-****`;
  });
  // Raw long tokens (24+ alnum chars) — keep first 4, mask rest
  s = s.replace(/\b[A-Za-z0-9]{24,}\b/g, (m) => `${m.slice(0, 4)}****`);
  // Email addresses
  s = s.replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, u, d) => {
    const head = u.length > 2 ? u.slice(0, 2) : u;
    return `${head}***@${d}`;
  });
  return s;
}

/**
 * Format a unix-ms or ISO timestamp as a short relative string ("just now",
 * "5m ago", "2h ago", "3d ago"). Returns "—" for missing/unparseable input.
 */
export function formatRelativeTime(v, now = Date.now()) {
  if (v === null || v === undefined || v === "") return "—";
  const ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  const delta = Math.max(0, Number(now) - ms);
  if (delta < 45_000) return "just now";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(delta / 86_400_000);
  return `${days}d ago`;
}

// ─── DOM helpers ───────────────────────────────────────────────────────────

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-admin-view="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-admin-view", "1");
  document.head.appendChild(link);
}

async function safeJson(resp) {
  try { return await resp.json(); } catch (_) { return null; }
}

// ─── Mount ─────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} el
 * @param {{ apiBase?: string, workspace?: string, fetchImpl?: typeof fetch }} [ctx]
 * @returns {{ destroy: () => void }}
 */
export default function mount(el, ctx = {}) {
  if (!el) throw new Error("mount root required");
  ensureStylesheet();

  const apiBase = (ctx.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const workspace = String(ctx.workspace || DEFAULT_WORKSPACE);
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  let destroyed = false;
  const state = {
    summary: null,     // cached across tabs
    summaryError: null,
    auditPage: 0,
  };

  el.innerHTML = "";
  const root = h("div", { class: "admin-view" });
  const header = h("header", { class: "admin-header" },
    h("h1", { class: "admin-title", text: "Admin" }),
    h("span", { class: "admin-subtitle", text: workspace }),
  );

  const tabs = h("div", { class: "admin-tabs", role: "tablist" });
  const body = h("div", { class: "admin-body" });

  const tabDefs = [
    { id: "workspaces", label: "Workspaces" },
    { id: "users", label: "Users" },
    { id: "audit", label: "Audit" },
    { id: "system", label: "System" },
  ];

  let active = "workspaces";
  const tabButtons = {};
  for (const t of tabDefs) {
    const btn = h("button", {
      class: "admin-tab",
      type: "button",
      role: "tab",
      onclick: () => setTab(t.id),
    }, t.label);
    tabButtons[t.id] = btn;
    tabs.appendChild(btn);
  }

  function setTab(id) {
    if (destroyed) return;
    active = id;
    for (const [tid, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle("admin-tab-active", tid === id);
      btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    }
    body.innerHTML = "";
    if (id === "workspaces") renderWorkspacesTab(body);
    else if (id === "users") renderUsersTab(body);
    else if (id === "audit") renderAuditTab(body);
    else if (id === "system") renderSystemTab(body);
  }

  root.appendChild(header);
  root.appendChild(tabs);
  root.appendChild(body);
  el.appendChild(root);
  setTab("workspaces");

  // ── Fetch helpers ───────────────────────────────────────────────────────

  async function fetchAdmin(path) {
    if (!fetchImpl) return { __error: new Error("fetch not available") };
    let resp;
    try {
      resp = await fetchImpl(`${apiBase}${path}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      return { __error: err };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { __unauthorized: true };
    }
    if (!resp.ok) {
      const b = await safeJson(resp);
      return { __error: new Error(b?.error?.message || b?.error || `HTTP ${resp.status}`) };
    }
    return resp.json().catch(() => null);
  }

  async function ensureSummary() {
    if (state.summary || state.summaryError) return;
    const data = await fetchAdmin("/api/admin/summary");
    if (destroyed) return;
    if (data?.__unauthorized) { state.summaryError = { unauthorized: true }; return; }
    if (data?.__error) { state.summaryError = { message: data.__error.message }; return; }
    state.summary = data || {};
  }

  function renderUnauthorized(container) {
    container.appendChild(h("div", { class: "admin-panel admin-unauth" },
      h("h2", { class: "admin-unauth-title", text: "You need admin access" }),
      h("p", { class: "admin-unauth-msg", text:
        "Your session is not authenticated for /api/admin/* endpoints. " +
        "Sign in with an admin API key at the legacy admin page to manage keys, quotas, and backups." }),
      h("a", { class: "admin-btn", href: "/admin", target: "_blank", rel: "noopener" }, "Open legacy admin"),
    ));
  }

  function renderError(container, message) {
    container.appendChild(h("div", { class: "admin-panel admin-error" },
      h("span", { class: "admin-error-label", text: "Error:" }),
      " ",
      h("span", { text: message || "Unknown error" }),
    ));
  }

  // ── Workspaces tab ──────────────────────────────────────────────────────

  async function renderWorkspacesTab(container) {
    const panel = h("div", { class: "admin-panel" });
    const status = h("div", { class: "admin-status", text: "Loading…" });
    panel.appendChild(status);
    container.appendChild(panel);
    await ensureSummary();
    if (destroyed) return;
    panel.innerHTML = "";
    if (state.summaryError?.unauthorized) { renderUnauthorized(container); return; }
    if (state.summaryError) { renderError(container, state.summaryError.message); return; }
    const rows = Array.isArray(state.summary?.workspaces) ? state.summary.workspaces : [];
    const summarized = rows.map(summarizeWorkspace);
    panel.appendChild(h("div", { class: "admin-toolbar" },
      h("h2", { class: "admin-panel-title", text: "Workspaces" }),
      h("span", { class: "admin-status", text: `${summarized.length} workspace${summarized.length === 1 ? "" : "s"}` }),
    ));
    if (summarized.length === 0) {
      panel.appendChild(h("div", { class: "admin-empty", text: "No workspaces." }));
      return;
    }
    const table = h("table", { class: "admin-table" },
      h("thead", null, h("tr", null,
        h("th", { text: "User" }),
        h("th", { text: "Workspace" }),
        h("th", { text: "Tokens used" }),
        h("th", { text: "Limit" }),
        h("th", { text: "Usage" }),
      )),
    );
    const tbody = h("tbody");
    for (const w of summarized) {
      const bar = h("div", { class: "admin-quota-bar" },
        h("div", {
          class: "admin-quota-fill" + (w.pct > 90 ? " admin-quota-err" : w.pct > 70 ? " admin-quota-warn" : ""),
          style: `width:${w.pct.toFixed(0)}%`,
        }),
      );
      tbody.appendChild(h("tr", null,
        h("td", { text: w.userId }),
        h("td", { text: w.workspaceName }),
        h("td", { text: w.tokensUsed.toLocaleString() }),
        h("td", { text: w.limit > 0 ? w.limit.toLocaleString() : "—" }),
        h("td", null, w.limit > 0 ? bar : h("span", { class: "admin-muted", text: "—" })),
      ));
    }
    table.appendChild(tbody);
    panel.appendChild(table);
    // TODO: wire "Suspend workspace" / "Set quota override" actions here (legacy UI
    // retains them via POST /api/admin/quotas/override).
  }

  // ── Users tab ───────────────────────────────────────────────────────────

  async function renderUsersTab(container) {
    const panel = h("div", { class: "admin-panel" });
    const status = h("div", { class: "admin-status", text: "Loading…" });
    panel.appendChild(status);
    container.appendChild(panel);
    await ensureSummary();
    if (destroyed) return;
    panel.innerHTML = "";
    if (state.summaryError?.unauthorized) { renderUnauthorized(container); return; }
    if (state.summaryError) { renderError(container, state.summaryError.message); return; }
    const rows = Array.isArray(state.summary?.users) ? state.summary.users : [];
    panel.appendChild(h("div", { class: "admin-toolbar" },
      h("h2", { class: "admin-panel-title", text: "Users" }),
      h("span", { class: "admin-status", text: `${rows.length} user${rows.length === 1 ? "" : "s"}` }),
    ));
    if (rows.length === 0) {
      panel.appendChild(h("div", { class: "admin-empty", text: "No users." }));
      return;
    }
    const table = h("table", { class: "admin-table" },
      h("thead", null, h("tr", null,
        h("th", { text: "User ID" }),
        h("th", { text: "Email" }),
        h("th", { text: "Provider" }),
        h("th", { text: "Role" }),
        h("th", { text: "Created" }),
      )),
    );
    const tbody = h("tbody");
    for (const u of rows) {
      tbody.appendChild(h("tr", null,
        h("td", null, h("code", { text: String(u?.id || u?.userId || "—") })),
        h("td", { text: redactSensitive(String(u?.email || "—")) }),
        h("td", { text: String(u?.provider || "—") }),
        h("td", { text: String(u?.role || "user") }),
        h("td", { text: formatRelativeTime(u?.createdAt) }),
      ));
    }
    table.appendChild(tbody);
    panel.appendChild(table);
    // TODO: wire "Disable user" / "Reset password" / "Force sign-out" actions here
    // (legacy UI retains these via /api/admin/users/* in follow-up PRs).
  }

  // ── Audit tab ───────────────────────────────────────────────────────────

  async function renderAuditTab(container) {
    const panel = h("div", { class: "admin-panel" });
    const toolbar = h("div", { class: "admin-toolbar" },
      h("h2", { class: "admin-panel-title", text: "Audit log" }),
      h("span", { class: "admin-status", text: "Loading…" }),
    );
    const tableWrap = h("div");
    const pager = h("div", { class: "admin-pager" });
    panel.appendChild(toolbar);
    panel.appendChild(tableWrap);
    panel.appendChild(pager);
    container.appendChild(panel);

    const offset = state.auditPage * AUDIT_PAGE_SIZE;
    const data = await fetchAdmin(`/api/admin/audit/query?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`);
    if (destroyed) return;
    if (data?.__unauthorized) {
      panel.remove();
      renderUnauthorized(container);
      return;
    }
    if (data?.__error) {
      toolbar.lastChild.textContent = "";
      renderError(container, data.__error.message);
      return;
    }
    const entries = Array.isArray(data?.entries) ? data.entries
      : Array.isArray(data?.items) ? data.items
      : [];
    const rows = entries.map(formatAuditEntry);
    toolbar.lastChild.textContent = `${rows.length} entr${rows.length === 1 ? "y" : "ies"} (page ${state.auditPage + 1})`;
    if (rows.length === 0) {
      tableWrap.appendChild(h("div", { class: "admin-empty", text: "No audit entries." }));
    } else {
      const table = h("table", { class: "admin-table" },
        h("thead", null, h("tr", null,
          h("th", { text: "Time" }),
          h("th", { text: "Action" }),
          h("th", { text: "User" }),
          h("th", { text: "Workspace" }),
          h("th", { text: "Status" }),
          h("th", { text: "Details" }),
        )),
      );
      const tbody = h("tbody");
      for (const r of rows) {
        tbody.appendChild(h("tr", null,
          h("td", null, h("code", { text: r.timestamp })),
          h("td", { text: r.action }),
          h("td", { text: r.userId }),
          h("td", { text: r.workspaceId }),
          h("td", null, h("span", { class: r.ok ? "admin-ok" : "admin-err", text: r.status })),
          h("td", { class: "admin-details", text: r.details || "—" }),
        ));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    }
    const prev = h("button", {
      class: "admin-btn",
      type: "button",
      disabled: state.auditPage === 0 ? "disabled" : null,
      onclick: () => { if (state.auditPage > 0) { state.auditPage--; setTab("audit"); } },
    }, "Prev");
    const next = h("button", {
      class: "admin-btn",
      type: "button",
      disabled: rows.length < AUDIT_PAGE_SIZE ? "disabled" : null,
      onclick: () => { if (rows.length >= AUDIT_PAGE_SIZE) { state.auditPage++; setTab("audit"); } },
    }, "Next");
    pager.appendChild(prev);
    pager.appendChild(h("span", { class: "admin-muted", text: `Page ${state.auditPage + 1}` }));
    pager.appendChild(next);
    // TODO: wire CSV/JSON export via /api/admin/audit/export (legacy UI exposes this).
  }

  // ── System tab ──────────────────────────────────────────────────────────

  async function renderSystemTab(container) {
    const panel = h("div", { class: "admin-panel" });
    const status = h("div", { class: "admin-status", text: "Loading…" });
    panel.appendChild(status);
    container.appendChild(panel);
    await ensureSummary();
    if (destroyed) return;
    panel.innerHTML = "";
    if (state.summaryError?.unauthorized) { renderUnauthorized(container); return; }
    if (state.summaryError) { renderError(container, state.summaryError.message); return; }
    const s = state.summary || {};
    const sys = s.system || {};
    const health = sys.health || {};
    const usage = s.usage || {};
    const apiKeys = Array.isArray(s.apiKeys) ? s.apiKeys : [];

    const cards = h("div", { class: "admin-cards" },
      card("Users", String((s.users || []).length)),
      card("Workspaces", String((s.workspaces || []).length)),
      card("API keys", String(apiKeys.length)),
      card("Requests (7d)", String(Number(usage.totalRequests || 0).toLocaleString())),
    );
    panel.appendChild(cards);

    const healthRow = (label, ok, extra) => h("tr", null,
      h("td", { text: label }),
      h("td", null,
        h("span", { class: ok ? "admin-ok" : "admin-err", text: ok ? "OK" : "FAIL" }),
        extra ? " " : null,
        extra ? h("span", { class: "admin-muted", text: extra }) : null,
      ),
    );

    const healthTable = h("table", { class: "admin-table" },
      h("tbody", null,
        healthRow("Backend reachable",
          Boolean(health?.reachable ?? health?.backend?.reachable),
          health?.backend?.latencyMs != null ? `(${health.backend.latencyMs} ms)` :
            health?.latencyMs != null ? `(${health.latencyMs} ms)` : null,
        ),
        h("tr", null,
          h("td", { text: "Storage backend" }),
          h("td", { text: String(sys?.storageBackend || "json") }),
        ),
        h("tr", null,
          h("td", { text: "Quota configured" }),
          h("td", null, sys?.quotaConfigured
            ? h("span", { class: "admin-ok", text: "enabled" })
            : h("span", { class: "admin-muted", text: "disabled" })),
        ),
        h("tr", null,
          h("td", { text: "Scheduler" }),
          h("td", null, sys?.scheduleEnabled
            ? h("span", { class: "admin-ok", text: "enabled" })
            : h("span", { class: "admin-muted", text: "disabled" })),
        ),
      ),
    );
    panel.appendChild(h("h2", { class: "admin-panel-title", text: "System health" }));
    panel.appendChild(healthTable);

    const integrations = sys.integrations || {};
    const intEntries = Object.entries(integrations);
    if (intEntries.length) {
      panel.appendChild(h("h2", { class: "admin-panel-title", text: "Integrations" }));
      const intTable = h("table", { class: "admin-table" });
      const ibody = h("tbody");
      for (const [name, enabled] of intEntries) {
        ibody.appendChild(h("tr", null,
          h("td", { text: name }),
          h("td", null, enabled
            ? h("span", { class: "admin-ok", text: "configured" })
            : h("span", { class: "admin-muted", text: "not configured" })),
        ));
      }
      intTable.appendChild(ibody);
      panel.appendChild(intTable);
    }
    // TODO: wire "Create backup" and "Archive audit to S3 now" actions here
    // (legacy UI keeps POST /api/v1/backup and POST /api/admin/audit/archive-now).
  }

  function card(label, value) {
    return h("div", { class: "admin-card" },
      h("div", { class: "admin-card-label", text: label }),
      h("div", { class: "admin-card-value", text: value }),
    );
  }

  return {
    destroy() {
      destroyed = true;
      try { el.innerHTML = ""; } catch (_) { /* ignore */ }
    },
  };
}
