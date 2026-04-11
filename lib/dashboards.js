/**
 * Phase 39.4: Custom dashboards.
 *
 * User-defined dashboards composed of widgets that visualize SiskelBot data
 * (analytics, health, knowledge counts, etc.). Dashboards are stored per
 * workspace under data/dashboards/{workspaceId}.json and respect the
 * configured storage backend via json-path-store.
 *
 * Storage layout:
 *   data/dashboards/{workspaceId}.json
 *     {
 *       _version: 1,
 *       dashboards: {
 *         [dashboardId]: {
 *           id, workspaceId, name, description, layout: { widgets: [...] },
 *           shareToken, createdAt, updatedAt, createdBy
 *         }
 *       }
 *     }
 *   data/dashboards/_index.json
 *     {
 *       _version: 1,
 *       byId: { [dashboardId]: workspaceId },
 *       byShareToken: { [shareToken]: dashboardId }
 *     }
 *
 * @module dashboards
 */
import { randomBytes } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_WIDGETS_PER_DASHBOARD = 50;
const MAX_DASHBOARDS_PER_WORKSPACE = 100;

// ─── widget catalog ──────────────────────────────────────────────────────────

export const WIDGET_TYPES = {
  metric_card: {
    name: "Metric Card",
    description: "Single number with optional trend indicator.",
    config: { metric: "requests", period: "7d", format: "number" },
  },
  line_chart: {
    name: "Line Chart",
    description: "Time-series chart of a metric over a period.",
    config: { metric: "requests", period: "7d", granularity: "day" },
  },
  bar_chart: {
    name: "Bar Chart",
    description: "Categorical bar chart grouped by a dimension.",
    config: { metric: "requests", groupBy: "model" },
  },
  table: {
    name: "Table",
    description: "Tabular data from a source.",
    config: { source: "top_models", columns: ["name", "requests"], limit: 10 },
  },
  text: {
    name: "Text",
    description: "Static text block (markdown supported).",
    config: { content: "", markdown: true },
  },
  iframe: {
    name: "IFrame",
    description: "Embed any URL as an iframe.",
    config: { url: "", height: 400 },
  },
  status: {
    name: "Status",
    description: "Health-check status indicator for a service.",
    config: { service: "self", healthEndpoint: "/health" },
  },
};

// ─── paths ───────────────────────────────────────────────────────────────────

function dashboardsPath(workspaceId) {
  const ws = sanitizeId(workspaceId) || "default";
  return join(getDataDir(), "dashboards", `${ws}.json`);
}

function indexPath() {
  return join(getDataDir(), "dashboards", "_index.json");
}

function sanitizeId(id) {
  if (!id || typeof id !== "string") return "";
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// ─── loaders ─────────────────────────────────────────────────────────────────

async function loadWorkspace(workspaceId) {
  const data = await readJsonPath(dashboardsPath(workspaceId), {
    _version: 1,
    dashboards: {},
  });
  if (!data || typeof data.dashboards !== "object" || data.dashboards === null) {
    return { _version: 1, dashboards: {} };
  }
  return data;
}

async function saveWorkspace(workspaceId, data) {
  await writeJsonPath(dashboardsPath(workspaceId), {
    _version: 1,
    dashboards: data.dashboards || {},
  });
}

async function loadIndex() {
  const data = await readJsonPath(indexPath(), {
    _version: 1,
    byId: {},
    byShareToken: {},
  });
  return {
    _version: 1,
    byId: data && typeof data.byId === "object" && data.byId !== null ? data.byId : {},
    byShareToken:
      data && typeof data.byShareToken === "object" && data.byShareToken !== null
        ? data.byShareToken
        : {},
  };
}

async function saveIndex(idx) {
  await writeJsonPath(indexPath(), {
    _version: 1,
    byId: idx.byId || {},
    byShareToken: idx.byShareToken || {},
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function genShareToken() {
  return randomBytes(16).toString("hex");
}

function normalizeWidget(raw, indexHint = 0) {
  if (!raw || typeof raw !== "object") {
    throw new Error("widget must be an object");
  }
  const type = String(raw.type || "").trim();
  if (!WIDGET_TYPES[type]) {
    throw new Error(`unknown widget type: ${type}`);
  }
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 80)
      : `w_${Date.now().toString(36)}_${indexHint}_${randomBytes(2).toString("hex")}`;

  const position =
    raw.position && typeof raw.position === "object"
      ? {
          x: Number.isFinite(Number(raw.position.x)) ? Number(raw.position.x) : 0,
          y: Number.isFinite(Number(raw.position.y)) ? Number(raw.position.y) : 0,
          w: Number.isFinite(Number(raw.position.w)) ? Number(raw.position.w) : 4,
          h: Number.isFinite(Number(raw.position.h)) ? Number(raw.position.h) : 3,
        }
      : { x: 0, y: 0, w: 4, h: 3 };

  const defaults = WIDGET_TYPES[type].config || {};
  const config = { ...defaults, ...(raw.config && typeof raw.config === "object" ? raw.config : {}) };

  return {
    id,
    type,
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : WIDGET_TYPES[type].name,
    position,
    config,
  };
}

function normalizeLayout(layout) {
  const widgets = Array.isArray(layout?.widgets) ? layout.widgets : [];
  if (widgets.length > MAX_WIDGETS_PER_DASHBOARD) {
    throw new Error(`too many widgets (max ${MAX_WIDGETS_PER_DASHBOARD})`);
  }
  return { widgets: widgets.map((w, i) => normalizeWidget(w, i)) };
}

// ─── public CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a new dashboard for a workspace.
 * @param {string} workspaceId
 * @param {string} name
 * @param {{ widgets?: Array }} [layout]
 * @param {{ description?: string, createdBy?: string }} [meta]
 */
export async function createDashboard(workspaceId, name, layout = { widgets: [] }, meta = {}) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  const cleanName = name.trim().slice(0, 200);
  if (!cleanName) throw new Error("name is required");

  const normalized = normalizeLayout(layout || { widgets: [] });

  let created;
  await withPathLock(dashboardsPath(workspaceId), async () => {
    const data = await loadWorkspace(workspaceId);
    if (Object.keys(data.dashboards).length >= MAX_DASHBOARDS_PER_WORKSPACE) {
      throw new Error(`max dashboards per workspace reached (${MAX_DASHBOARDS_PER_WORKSPACE})`);
    }
    const id = genId("dash");
    const shareToken = genShareToken();
    const now = new Date().toISOString();
    const record = {
      id,
      workspaceId,
      name: cleanName,
      description: typeof meta.description === "string" ? meta.description.slice(0, 2000) : "",
      layout: normalized,
      shareToken,
      createdAt: now,
      updatedAt: now,
      createdBy: typeof meta.createdBy === "string" ? meta.createdBy : null,
    };
    data.dashboards[id] = record;
    await saveWorkspace(workspaceId, data);
    created = record;
  });

  await withPathLock(indexPath(), async () => {
    const idx = await loadIndex();
    idx.byId[created.id] = workspaceId;
    idx.byShareToken[created.shareToken] = created.id;
    await saveIndex(idx);
  });

  return created;
}

/**
 * Update fields on an existing dashboard. Allowed updates: name, description, layout.
 */
export async function updateDashboard(dashboardId, updates = {}) {
  if (!dashboardId || typeof dashboardId !== "string") {
    throw new Error("dashboardId is required");
  }
  const workspaceId = await resolveWorkspaceId(dashboardId);
  if (!workspaceId) throw new Error("dashboard not found");

  let updated;
  await withPathLock(dashboardsPath(workspaceId), async () => {
    const data = await loadWorkspace(workspaceId);
    const existing = data.dashboards[dashboardId];
    if (!existing) throw new Error("dashboard not found");

    if (typeof updates.name === "string") {
      const cleanName = updates.name.trim().slice(0, 200);
      if (!cleanName) throw new Error("name cannot be empty");
      existing.name = cleanName;
    }
    if (typeof updates.description === "string") {
      existing.description = updates.description.slice(0, 2000);
    }
    if (updates.layout && typeof updates.layout === "object") {
      existing.layout = normalizeLayout(updates.layout);
    }
    existing.updatedAt = new Date().toISOString();
    data.dashboards[dashboardId] = existing;
    await saveWorkspace(workspaceId, data);
    updated = existing;
  });
  return updated;
}

/**
 * Delete a dashboard.
 */
export async function deleteDashboard(dashboardId) {
  if (!dashboardId || typeof dashboardId !== "string") {
    throw new Error("dashboardId is required");
  }
  const workspaceId = await resolveWorkspaceId(dashboardId);
  if (!workspaceId) return { ok: false, error: "not found" };

  let removed = null;
  await withPathLock(dashboardsPath(workspaceId), async () => {
    const data = await loadWorkspace(workspaceId);
    if (!data.dashboards[dashboardId]) return;
    removed = data.dashboards[dashboardId];
    delete data.dashboards[dashboardId];
    await saveWorkspace(workspaceId, data);
  });

  if (!removed) return { ok: false, error: "not found" };

  await withPathLock(indexPath(), async () => {
    const idx = await loadIndex();
    delete idx.byId[dashboardId];
    if (removed.shareToken) delete idx.byShareToken[removed.shareToken];
    await saveIndex(idx);
  });
  return { ok: true };
}

/**
 * List dashboards for a workspace, ordered by updatedAt desc.
 */
export async function listDashboards(workspaceId) {
  if (!workspaceId) return [];
  const data = await loadWorkspace(workspaceId);
  return Object.values(data.dashboards).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Get a single dashboard by ID.
 */
export async function getDashboard(dashboardId) {
  if (!dashboardId) return null;
  const workspaceId = await resolveWorkspaceId(dashboardId);
  if (!workspaceId) return null;
  const data = await loadWorkspace(workspaceId);
  return data.dashboards[dashboardId] || null;
}

/**
 * Look up a dashboard by its share token (read-only public access).
 */
export async function getDashboardByShareToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = await loadIndex();
  const dashboardId = idx.byShareToken[token];
  if (!dashboardId) return null;
  return getDashboard(dashboardId);
}

/**
 * Clone a dashboard, copying its layout into a new dashboard.
 */
export async function cloneDashboard(dashboardId, newName) {
  const source = await getDashboard(dashboardId);
  if (!source) throw new Error("dashboard not found");
  const name =
    (typeof newName === "string" && newName.trim()) || `${source.name} (copy)`;
  return createDashboard(source.workspaceId, name, source.layout, {
    description: source.description,
    createdBy: source.createdBy || null,
  });
}

// ─── widget rendering ────────────────────────────────────────────────────────

/**
 * Render a widget by fetching its data. Falls back to a placeholder when the
 * underlying data source is not available so dashboards still render.
 *
 * @param {object} widget
 * @param {{ workspaceId?: string }} [context]
 * @returns {Promise<{ widgetId: string, type: string, data: any, error?: string }>}
 */
export async function renderWidget(widget, context = {}) {
  if (!widget || !widget.type || !WIDGET_TYPES[widget.type]) {
    return { widgetId: widget?.id || "unknown", type: widget?.type || "unknown", data: null, error: "unknown widget type" };
  }
  try {
    const data = await fetchWidgetData(widget, context);
    return { widgetId: widget.id, type: widget.type, data };
  } catch (err) {
    return { widgetId: widget.id, type: widget.type, data: null, error: err.message };
  }
}

/**
 * Fetch and render data for every widget on a dashboard.
 */
export async function getDashboardData(dashboardId) {
  const dashboard = await getDashboard(dashboardId);
  if (!dashboard) throw new Error("dashboard not found");
  const widgets = dashboard.layout?.widgets || [];
  const ctx = { workspaceId: dashboard.workspaceId };
  const results = await Promise.all(widgets.map((w) => renderWidget(w, ctx)));
  return {
    dashboardId: dashboard.id,
    name: dashboard.name,
    updatedAt: dashboard.updatedAt,
    fetchedAt: new Date().toISOString(),
    widgets: results,
  };
}

// ─── data fetchers ───────────────────────────────────────────────────────────

async function fetchWidgetData(widget, context) {
  const cfg = widget.config || {};
  switch (widget.type) {
    case "text":
      return { content: typeof cfg.content === "string" ? cfg.content : "", markdown: cfg.markdown !== false };

    case "iframe":
      return { url: typeof cfg.url === "string" ? cfg.url : "", height: Number(cfg.height) || 400 };

    case "status":
      return await fetchStatusData(cfg);

    case "metric_card":
      return await fetchMetricCardData(cfg, context);

    case "line_chart":
      return await fetchLineChartData(cfg, context);

    case "bar_chart":
      return await fetchBarChartData(cfg, context);

    case "table":
      return await fetchTableData(cfg, context);

    default:
      throw new Error(`unsupported widget type: ${widget.type}`);
  }
}

function periodToDays(period) {
  if (typeof period !== "string") return 7;
  const m = period.match(/^(\d+)([dh])$/);
  if (!m) return 7;
  const n = parseInt(m[1], 10);
  if (m[2] === "h") return Math.max(1, Math.ceil(n / 24));
  return Math.max(1, n);
}

async function loadAnalyticsDashboard(period, workspaceId) {
  try {
    const mod = await import("./analytics.js");
    if (typeof mod.getDashboard === "function") {
      return await mod.getDashboard(periodToDays(period), workspaceId ? { workspace: workspaceId } : {});
    }
  } catch (_) {
    // Ignore — fall through to empty payload below.
  }
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    byModel: {},
    byDay: {},
    byWorkspace: {},
  };
}

async function fetchMetricCardData(cfg, context) {
  const metric = String(cfg.metric || "requests");
  const period = String(cfg.period || "7d");
  const dash = await loadAnalyticsDashboard(period, context.workspaceId);
  let value = 0;
  switch (metric) {
    case "requests":
      value = dash.totalRequests || 0;
      break;
    case "input_tokens":
      value = dash.totalInputTokens || 0;
      break;
    case "output_tokens":
      value = dash.totalOutputTokens || 0;
      break;
    case "tokens":
      value = (dash.totalInputTokens || 0) + (dash.totalOutputTokens || 0);
      break;
    case "cost":
      value = dash.totalCost || 0;
      break;
    default:
      value = 0;
  }
  return {
    metric,
    period,
    value,
    format: cfg.format || (metric === "cost" ? "currency" : "number"),
  };
}

async function fetchLineChartData(cfg, context) {
  const metric = String(cfg.metric || "requests");
  const period = String(cfg.period || "7d");
  const dash = await loadAnalyticsDashboard(period, context.workspaceId);
  const byDay = dash.byDay || {};
  const points = Object.keys(byDay)
    .sort()
    .map((day) => {
      const row = byDay[day] || {};
      let v = 0;
      if (metric === "requests") v = row.requests || 0;
      else if (metric === "input_tokens") v = row.inputTokens || 0;
      else if (metric === "output_tokens") v = row.outputTokens || 0;
      else if (metric === "tokens") v = (row.inputTokens || 0) + (row.outputTokens || 0);
      return { x: day, y: v };
    });
  return { metric, period, granularity: cfg.granularity || "day", points };
}

async function fetchBarChartData(cfg, context) {
  const metric = String(cfg.metric || "requests");
  const groupBy = String(cfg.groupBy || "model");
  const dash = await loadAnalyticsDashboard("30d", context.workspaceId);
  const source = groupBy === "workspace" ? dash.byWorkspace : dash.byModel;
  const bars = Object.entries(source || {}).map(([label, row]) => {
    let v = 0;
    if (metric === "requests") v = row.requests || 0;
    else if (metric === "input_tokens") v = row.inputTokens || 0;
    else if (metric === "output_tokens") v = row.outputTokens || 0;
    else if (metric === "tokens") v = (row.inputTokens || 0) + (row.outputTokens || 0);
    return { label, value: v };
  });
  bars.sort((a, b) => b.value - a.value);
  return { metric, groupBy, bars: bars.slice(0, 20) };
}

async function fetchTableData(cfg, context) {
  const source = String(cfg.source || "top_models");
  const limit = Math.max(1, Math.min(100, Number(cfg.limit) || 10));
  const columns = Array.isArray(cfg.columns) && cfg.columns.length > 0 ? cfg.columns : ["name", "requests"];
  const dash = await loadAnalyticsDashboard("30d", context.workspaceId);
  let rows = [];
  if (source === "top_models") {
    rows = Object.entries(dash.byModel || {}).map(([name, r]) => ({
      name,
      requests: r.requests || 0,
      input_tokens: r.inputTokens || 0,
      output_tokens: r.outputTokens || 0,
    }));
    rows.sort((a, b) => b.requests - a.requests);
  } else if (source === "top_workspaces") {
    rows = Object.entries(dash.byWorkspace || {}).map(([name, r]) => ({
      name,
      requests: r.requests || 0,
      input_tokens: r.inputTokens || 0,
      output_tokens: r.outputTokens || 0,
    }));
    rows.sort((a, b) => b.requests - a.requests);
  } else if (source === "by_day") {
    rows = Object.entries(dash.byDay || {})
      .map(([day, r]) => ({
        name: day,
        requests: r.requests || 0,
        input_tokens: r.inputTokens || 0,
        output_tokens: r.outputTokens || 0,
      }))
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }
  return { source, columns, rows: rows.slice(0, limit) };
}

async function fetchStatusData(cfg) {
  const service = typeof cfg.service === "string" ? cfg.service : "self";
  const endpoint = typeof cfg.healthEndpoint === "string" ? cfg.healthEndpoint : "/health";
  // For now, return a static OK marker. The client may augment this with a
  // live probe of the endpoint when it has access. We avoid making outbound
  // network calls here so the renderer stays cheap and side-effect free.
  return { service, endpoint, status: "unknown" };
}

// ─── internal ────────────────────────────────────────────────────────────────

async function resolveWorkspaceId(dashboardId) {
  const idx = await loadIndex();
  return idx.byId[dashboardId] || null;
}

// ─── exported constants ──────────────────────────────────────────────────────

export const DASHBOARD_LIMITS = {
  MAX_WIDGETS_PER_DASHBOARD,
  MAX_DASHBOARDS_PER_WORKSPACE,
};
