/**
 * Pure HTML render helpers for the right-side inspector drawer.
 *
 * Exports:
 *   - renderChatSignals({ cost, latencyMs, model, tokens })
 *   - renderTrajectoryTree(events)
 *   - renderGraphNeighbors({ entity, neighbors })
 *
 * All functions return HTML strings. They escape every dynamic
 * field so callers can pass arbitrary user / API data safely.
 * No DOM access — these helpers must remain unit-testable in plain Node.
 */

const MAX_TRAJECTORY_EVENTS = 50;

export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "&mdash;";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const digits = abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

function fmtMs(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "&mdash;";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function fmtTokens(t) {
  if (!t || typeof t !== "object") return "&mdash;";
  const p = Number.isFinite(t.prompt) ? t.prompt : null;
  const c = Number.isFinite(t.completion) ? t.completion : null;
  if (p === null && c === null) return "&mdash;";
  return `${p ?? "&mdash;"} in / ${c ?? "&mdash;"} out`;
}

/**
 * Render the chat "Last response" panel.
 * Missing fields render as an em-dash.
 */
export function renderChatSignals(input) {
  const data = input || {};
  const rows = [
    { label: "Cost", value: fmtUsd(data.cost) },
    { label: "Latency", value: fmtMs(data.latencyMs) },
    { label: "Model", value: data.model ? escapeHtml(data.model) : "&mdash;" },
    { label: "Tokens", value: fmtTokens(data.tokens) },
  ];
  const items = rows
    .map(
      (r) =>
        `<div class="sb-ic-row"><span class="sb-ic-k">${escapeHtml(r.label)}</span>` +
        `<span class="sb-ic-v">${r.value}</span></div>`,
    )
    .join("");
  return `<div class="sb-ic sb-ic-chat">${items}</div>`;
}

function summarizeTrajEvent(ev) {
  const p = (ev && ev.payload) || {};
  const t = ev && ev.type;
  if (t === "tool.call") return `${escapeHtml(p.tool || p.name || "tool")}(…)`;
  if (t === "tool.result") {
    const r = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
    const trimmed = r.length > 80 ? r.slice(0, 80) + "…" : r;
    return `${escapeHtml(p.tool || p.name || "tool")} → ${escapeHtml(trimmed)}`;
  }
  if (t === "plan.update") return escapeHtml(p.summary || "plan updated");
  if (t === "hitl.request") return `approval: ${escapeHtml(p.tool || p.summary || "")}`;
  if (t === "hitl.resolved") return `resolved: ${escapeHtml(p.decision || "")}`;
  if (t === "artifact.new") return `artifact: ${escapeHtml(p.name || p.id || "")}`;
  if (t === "cost.update") {
    const v = Number(p.totalUsd ?? p.costUsd);
    return `cost: ${Number.isFinite(v) ? escapeHtml(v.toFixed(v < 1 ? 4 : 2)) : "0"}`;
  }
  if (t === "status.change") return escapeHtml(p.status || "status");
  if (t === "done") return "done";
  return escapeHtml(JSON.stringify(p).slice(0, 80));
}

/**
 * Render a compact trajectory tree, grouped by tool name (or event type).
 * Truncates to the most recent MAX_TRAJECTORY_EVENTS events.
 */
export function renderTrajectoryTree(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<div class="sb-ic sb-ic-traj"><div class="sb-ic-empty">No events yet.</div></div>`;
  }
  const slice = events.slice(-MAX_TRAJECTORY_EVENTS);
  const groups = new Map();
  for (const ev of slice) {
    const key = ev && ev.type ? String(ev.type) : "event";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const sections = [];
  for (const [key, list] of groups.entries()) {
    const lis = list
      .map((ev) => `<li class="sb-ic-traj-item">${summarizeTrajEvent(ev)}</li>`)
      .join("");
    sections.push(
      `<details class="sb-ic-traj-group" open>` +
        `<summary>${escapeHtml(key)} <span class="sb-ic-count">(${list.length})</span></summary>` +
        `<ul class="sb-ic-traj-list">${lis}</ul>` +
        `</details>`,
    );
  }
  const truncated =
    events.length > MAX_TRAJECTORY_EVENTS
      ? `<div class="sb-ic-trunc">Showing last ${MAX_TRAJECTORY_EVENTS} of ${events.length}</div>`
      : "";
  return `<div class="sb-ic sb-ic-traj">${truncated}${sections.join("")}</div>`;
}

/**
 * Render the knowledge "Graph neighbors" panel for a focused entity.
 * `neighbors` is an array of `{ name, type, relationship }`. Each row
 * carries a `data-entity` attribute so callers can wire click handlers.
 */
export function renderGraphNeighbors(input) {
  const data = input || {};
  const entityLabel = data.entity ? escapeHtml(data.entity) : "(unknown)";
  const neighbors = Array.isArray(data.neighbors) ? data.neighbors : [];
  if (neighbors.length === 0) {
    return (
      `<div class="sb-ic sb-ic-graph">` +
        `<div class="sb-ic-head">${entityLabel}</div>` +
        `<div class="sb-ic-empty">No related entities.</div>` +
      `</div>`
    );
  }
  const rows = neighbors
    .map((n) => {
      const name = escapeHtml((n && (n.name || n.id)) || "(unnamed)");
      const rel = escapeHtml((n && (n.relationship || n.rel || n.type)) || "");
      const handle = escapeHtml((n && (n.id || n.name)) || "");
      return (
        `<li class="sb-ic-graph-row" data-entity="${handle}">` +
          `<span class="sb-ic-graph-name">${name}</span>` +
          `<span class="sb-ic-graph-rel">${rel}</span>` +
        `</li>`
      );
    })
    .join("");
  return (
    `<div class="sb-ic sb-ic-graph">` +
      `<div class="sb-ic-head">${entityLabel}</div>` +
      `<ul class="sb-ic-graph-list">${rows}</ul>` +
    `</div>`
  );
}
