/**
 * Knowledge view for the SiskelBot SPA shell.
 *
 * Three tabs:
 *   - Docs:   list / add / edit / delete knowledge base documents.
 *   - Search: keyword or semantic search with fallback.
 *   - Graph:  simple circular layout of the knowledge graph.
 *
 * Pure helpers (formatDocSize, rankSearchResults, layoutEntitiesCircular)
 * are exported for tests.
 */

import { renderGraphNeighbors } from "./inspector-content.js";

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_WORKSPACE = "default";
const CSS_HREF = new URL("./knowledge.css", import.meta.url).href;

async function fetchGraphNeighborsForDoc(apiBase, workspace, doc) {
  const tries = [doc.title, doc.id].filter(Boolean);
  for (const ent of tries) {
    try {
      const url =
        `${apiBase}/knowledge/graph?workspace=${encodeURIComponent(workspace)}` +
        `&entity=${encodeURIComponent(ent)}`;
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data) continue;
      const ents = Array.isArray(data?.entities) ? data.entities
        : Array.isArray(data?.nodes) ? data.nodes : [];
      const rels = Array.isArray(data?.relationships) ? data.relationships
        : Array.isArray(data?.edges) ? data.edges
        : Array.isArray(data?.links) ? data.links : [];
      const byId = new Map();
      for (const e of ents) {
        const id = e.id ?? e.name;
        if (id != null) byId.set(String(id), { id: String(id), name: e.name ?? e.label ?? String(id), type: e.type ?? e.kind ?? "" });
      }
      const focus = String(ent);
      const neighbors = [];
      for (const r of rels) {
        const s = String(r.source ?? r.from ?? r.src ?? "");
        const t = String(r.target ?? r.to ?? r.dst ?? "");
        const rel = String(r.type ?? r.relationship ?? r.label ?? "related");
        if (s === focus && t) neighbors.push({ ...(byId.get(t) || { id: t, name: t }), relationship: rel });
        else if (t === focus && s) neighbors.push({ ...(byId.get(s) || { id: s, name: s }), relationship: rel });
      }
      return { entity: focus, neighbors };
    } catch { /* try next */ }
  }
  return null;
}

function pushGraphNeighborsToInspector(payload) {
  try {
    const ins = globalThis.SiskelbotShell?.inspector;
    if (!ins) return;
    if (!payload) { ins.setContent?.(""); ins.setTitle?.("Inspector"); return; }
    ins.setTitle?.("Graph neighbors");
    ins.setContent?.(renderGraphNeighbors(payload));
  } catch { /* noop */ }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Format a byte size as a human-readable string.
 * Returns "—" for null/undefined/non-numeric. Returns "0 B" for 0.
 */
export function formatDocSize(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n)) return "—";
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Stable sort: higher score first, ties broken by updatedAt desc, then
 * title asc. Pure — returns a new array, does not mutate input.
 */
export function rankSearchResults(results, _query) {
  if (!Array.isArray(results)) return [];
  const indexed = results.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const sa = Number(a.r?.score ?? 0);
    const sb = Number(b.r?.score ?? 0);
    if (sb !== sa) return sb - sa;
    const ua = toMs(a.r?.updatedAt);
    const ub = toMs(b.r?.updatedAt);
    if (ub !== ua) return ub - ua;
    const ta = String(a.r?.title || "");
    const tb = String(b.r?.title || "");
    const tcmp = ta.localeCompare(tb);
    if (tcmp !== 0) return tcmp;
    return a.i - b.i;
  });
  return indexed.map((x) => x.r);
}

function toMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Deterministic circular layout. Places entities evenly around a circle.
 * Angle for entity i: (2π * i / n) - π/2  (first entity at top).
 */
export function layoutEntitiesCircular(entities, radius = 250, center = { x: 300, y: 300 }) {
  if (!Array.isArray(entities) || entities.length === 0) return [];
  const n = entities.length;
  const cx = Number(center?.x ?? 300);
  const cy = Number(center?.y ?? 300);
  const r = Number(radius);
  return entities.map((e, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    return {
      id: e?.id != null ? String(e.id) : String(i),
      name: e?.name != null ? String(e.name) : "",
      type: e?.type != null ? String(e.type) : "",
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });
}

// ── View ─────────────────────────────────────────────────────────────────────

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector('link[data-knowledge-view="1"]');
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-knowledge-view", "1");
  document.head.appendChild(link);
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function formatDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(s);
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, { credentials: "same-origin", ...opts });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export default function mount(el, ctx) {
  ensureStylesheet();
  const apiBase = (ctx && ctx.apiBase) || DEFAULT_API_BASE;
  const workspace = (ctx && ctx.workspace) || DEFAULT_WORKSPACE;
  el.innerHTML = "";
  el.appendChild(render(apiBase, workspace));
  return () => {
    try { el.innerHTML = ""; } catch (_) { /* noop */ }
    try { globalThis.SiskelbotShell?.inspector?.clear(); } catch (_) { /* noop */ }
  };
}

function render(apiBase, workspace) {
  const root = h("div", { class: "kb-view" });
  const header = h("div", { class: "kb-header" },
    h("h1", { class: "kb-title", text: "Knowledge" }),
    h("span", { class: "kb-subtitle", text: workspace })
  );
  const tabs = h("div", { class: "kb-tabs" });
  const body = h("div", { class: "kb-body" });

  const tabNames = [
    { id: "docs", label: "Docs" },
    { id: "search", label: "Search" },
    { id: "graph", label: "Graph" },
  ];

  let active = "docs";
  const tabButtons = {};
  for (const t of tabNames) {
    const btn = h("button", {
      class: "kb-tab",
      type: "button",
      onclick: () => setTab(t.id),
    }, t.label);
    tabButtons[t.id] = btn;
    tabs.appendChild(btn);
  }

  function setTab(id) {
    active = id;
    for (const [tid, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle("kb-tab-active", tid === id);
    }
    body.innerHTML = "";
    if (id === "docs") renderDocsTab(body, apiBase, workspace);
    else if (id === "search") renderSearchTab(body, apiBase, workspace);
    else if (id === "graph") renderGraphTab(body, apiBase, workspace);
  }

  root.appendChild(header);
  root.appendChild(tabs);
  root.appendChild(body);
  setTab("docs");
  return root;
}

// ── Docs tab ─────────────────────────────────────────────────────────────────

function adaptDocList(payload) {
  const items = Array.isArray(payload) ? payload
    : Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.documents) ? payload.documents
    : [];
  return items.map((d) => ({
    id: d.id ?? d._id ?? "",
    title: d.title ?? d.name ?? "(untitled)",
    sizeBytes: d.sizeBytes ?? d.size ?? (typeof d.content === "string" ? d.content.length : null),
    updatedAt: d.updatedAt ?? d.createdAt ?? null,
    content: d.content ?? "",
  }));
}

async function renderDocsTab(body, apiBase, workspace) {
  const panel = h("div", { class: "kb-panel" });
  const toolbar = h("div", { class: "kb-toolbar" },
    h("button", { class: "kb-btn kb-btn-primary", type: "button", onclick: () => showAddForm() }, "Add document"),
    h("span", { class: "kb-status", id: "kb-docs-status", text: "Loading…" })
  );
  const list = h("div", { class: "kb-list" });
  panel.appendChild(toolbar);
  panel.appendChild(list);
  body.appendChild(panel);

  const status = toolbar.querySelector("#kb-docs-status");

  async function reload() {
    list.innerHTML = "";
    status.textContent = "Loading…";
    try {
      const data = await jsonFetch(`${apiBase}/context?workspace=${encodeURIComponent(workspace)}`);
      const docs = adaptDocList(data);
      status.textContent = `${docs.length} document${docs.length === 1 ? "" : "s"}`;
      if (docs.length === 0) {
        list.appendChild(h("div", { class: "kb-empty", text: "No documents yet." }));
        return;
      }
      for (const doc of docs) {
        const row = h("div", { class: "kb-row", onclick: () => showDetail(doc) },
          h("div", { class: "kb-row-title", text: doc.title }),
          h("div", { class: "kb-row-meta" },
            h("span", { text: formatDocSize(doc.sizeBytes) }),
            h("span", { text: "•" }),
            h("span", { text: formatDate(doc.updatedAt) })
          )
        );
        list.appendChild(row);
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  }

  function showAddForm() {
    panel.innerHTML = "";
    const form = h("div", { class: "kb-form" },
      h("div", { class: "kb-form-title", text: "Add document" }),
      h("input", { class: "kb-input", id: "kb-form-title", type: "text", placeholder: "Title" }),
      h("textarea", { class: "kb-textarea", id: "kb-form-content", placeholder: "Content", rows: "10" }),
      h("div", { class: "kb-form-actions" },
        h("button", { class: "kb-btn", type: "button", onclick: () => restore() }, "Cancel"),
        h("button", { class: "kb-btn kb-btn-primary", type: "button", onclick: () => save() }, "Save")
      ),
      h("div", { class: "kb-form-status", id: "kb-form-status" })
    );
    panel.appendChild(form);

    async function save() {
      const title = form.querySelector("#kb-form-title").value.trim();
      const content = form.querySelector("#kb-form-content").value;
      const st = form.querySelector("#kb-form-status");
      if (!title) { st.textContent = "Title is required."; return; }
      st.textContent = "Saving…";
      try {
        await jsonFetch(`${apiBase}/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, content, workspace }),
        });
        restore();
      } catch (err) {
        st.textContent = `Error: ${err.message}`;
      }
    }
    function restore() {
      panel.innerHTML = "";
      panel.appendChild(toolbar);
      panel.appendChild(list);
      reload();
    }
  }

  function showDetail(doc) {
    panel.innerHTML = "";
    fetchGraphNeighborsForDoc(apiBase, workspace, doc)
      .then(pushGraphNeighborsToInspector)
      .catch(() => pushGraphNeighborsToInspector(null));
    let editing = false;
    const detail = h("div", { class: "kb-detail" });
    const heading = h("div", { class: "kb-detail-header" },
      h("button", { class: "kb-btn", type: "button", onclick: () => restore() }, "← Back"),
      h("div", { class: "kb-detail-title", text: doc.title }),
      h("button", { class: "kb-btn", type: "button", onclick: () => toggleEdit() }, "Edit"),
      h("button", { class: "kb-btn kb-btn-danger", type: "button", onclick: () => del() }, "Delete")
    );
    const contentEl = h("pre", { class: "kb-detail-content", text: doc.content || "" });
    const statusEl = h("div", { class: "kb-form-status" });
    detail.appendChild(heading);
    detail.appendChild(contentEl);
    detail.appendChild(statusEl);
    panel.appendChild(detail);

    function toggleEdit() {
      editing = !editing;
      detail.innerHTML = "";
      detail.appendChild(heading);
      if (editing) {
        const ta = h("textarea", { class: "kb-textarea", rows: "16" });
        ta.value = doc.content || "";
        const saveBtn = h("button", { class: "kb-btn kb-btn-primary", type: "button", onclick: () => saveEdit(ta.value) }, "Save");
        detail.appendChild(ta);
        detail.appendChild(h("div", { class: "kb-form-actions" }, saveBtn));
      } else {
        detail.appendChild(contentEl);
      }
      detail.appendChild(statusEl);
    }

    async function saveEdit(newContent) {
      statusEl.textContent = "Saving…";
      try {
        await jsonFetch(`${apiBase}/context/${encodeURIComponent(doc.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: doc.title, content: newContent, workspace }),
        });
        doc.content = newContent;
        contentEl.textContent = newContent;
        editing = false;
        toggleEdit();
        toggleEdit();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    }

    async function del() {
      if (typeof confirm === "function" && !confirm(`Delete "${doc.title}"?`)) return;
      statusEl.textContent = "Deleting…";
      try {
        await jsonFetch(`${apiBase}/context/${encodeURIComponent(doc.id)}?workspace=${encodeURIComponent(workspace)}`, {
          method: "DELETE",
        });
        restore();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    }

    function restore() {
      panel.innerHTML = "";
      panel.appendChild(toolbar);
      panel.appendChild(list);
      reload();
    }
  }

  await reload();
}

// ── Search tab ───────────────────────────────────────────────────────────────

function adaptSearchResults(payload) {
  const raw = Array.isArray(payload) ? payload
    : Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.hits) ? payload.hits
    : [];
  return raw.map((r) => ({
    id: r.id ?? r.documentId ?? r.docId ?? "",
    title: r.title ?? r.name ?? "(untitled)",
    snippet: r.snippet ?? r.excerpt ?? r.preview ?? "",
    score: Number(r.score ?? r._score ?? 0),
    updatedAt: r.updatedAt ?? r.createdAt ?? null,
  }));
}

function renderSearchTab(body, apiBase, workspace) {
  const panel = h("div", { class: "kb-panel" });
  const input = h("input", { class: "kb-input kb-search-input", type: "text", placeholder: "Search documents" });
  const keywordRadio = h("input", { type: "radio", name: "kb-mode", value: "keyword", checked: "checked" });
  const semanticRadio = h("input", { type: "radio", name: "kb-mode", value: "semantic" });
  const form = h("div", { class: "kb-search-form" },
    input,
    h("button", { class: "kb-btn kb-btn-primary", type: "button", onclick: () => run() }, "Search"),
    h("label", { class: "kb-radio" }, keywordRadio, " Keyword"),
    h("label", { class: "kb-radio" }, semanticRadio, " Semantic")
  );
  const notice = h("div", { class: "kb-notice" });
  const status = h("div", { class: "kb-status" });
  const results = h("div", { class: "kb-list" });
  panel.appendChild(form);
  panel.appendChild(notice);
  panel.appendChild(status);
  panel.appendChild(results);
  body.appendChild(panel);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  async function run() {
    const q = input.value.trim();
    notice.textContent = "";
    results.innerHTML = "";
    if (!q) { status.textContent = "Enter a query."; return; }
    const mode = semanticRadio.checked ? "semantic" : "keyword";
    status.textContent = "Searching…";
    try {
      let payload;
      if (mode === "semantic") {
        try {
          payload = await jsonFetch(`${apiBase}/context/semantic?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(workspace)}`);
        } catch (err) {
          if (err.status === 404) {
            notice.textContent = "Semantic search unavailable — using keyword search.";
            payload = await jsonFetch(`${apiBase}/search?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(workspace)}`);
          } else {
            throw err;
          }
        }
      } else {
        payload = await jsonFetch(`${apiBase}/search?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(workspace)}`);
      }
      const ranked = rankSearchResults(adaptSearchResults(payload), q);
      status.textContent = `${ranked.length} result${ranked.length === 1 ? "" : "s"}`;
      for (const r of ranked) {
        const row = h("div", { class: "kb-row" },
          h("div", { class: "kb-row-head" },
            h("span", { class: "kb-score", text: r.score.toFixed(2) }),
            h("a", { class: "kb-row-title", href: `#doc-${r.id}`, text: r.title })
          ),
          r.snippet ? h("div", { class: "kb-snippet", text: r.snippet }) : null
        );
        results.appendChild(row);
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  }
}

// ── Graph tab ────────────────────────────────────────────────────────────────

function adaptGraph(payload) {
  const entities = Array.isArray(payload?.entities) ? payload.entities
    : Array.isArray(payload?.nodes) ? payload.nodes
    : [];
  const relationships = Array.isArray(payload?.relationships) ? payload.relationships
    : Array.isArray(payload?.edges) ? payload.edges
    : Array.isArray(payload?.links) ? payload.links
    : [];
  const ents = entities.map((e) => ({
    id: e.id ?? e.name ?? "",
    name: e.name ?? e.label ?? e.id ?? "",
    type: e.type ?? e.kind ?? "",
  }));
  const rels = relationships.map((r) => ({
    source: r.source ?? r.from ?? r.src ?? "",
    target: r.target ?? r.to ?? r.dst ?? "",
  }));
  return { entities: ents, relationships: rels };
}

async function renderGraphTab(body, apiBase, workspace) {
  const panel = h("div", { class: "kb-panel" });
  const status = h("div", { class: "kb-status", text: "Loading graph…" });
  const canvasWrap = h("div", { class: "kb-canvas-wrap" });
  const canvas = h("canvas", { width: "600", height: "600", class: "kb-canvas" });
  canvasWrap.appendChild(canvas);
  panel.appendChild(status);
  panel.appendChild(canvasWrap);
  body.appendChild(panel);

  let graph = null;
  try {
    const payload = await jsonFetch(`${apiBase}/knowledge/graph?workspace=${encodeURIComponent(workspace)}&limit=100`);
    graph = adaptGraph(payload);
  } catch (err) {
    status.textContent = "Graph unavailable";
    canvasWrap.remove();
    return;
  }

  if (!graph || graph.entities.length === 0) {
    status.textContent = "Graph unavailable";
    canvasWrap.remove();
    return;
  }

  const positions = layoutEntitiesCircular(graph.entities, 250, { x: 300, y: 300 });
  const posById = new Map(positions.map((p) => [p.id, p]));
  const neighbors = new Map();
  for (const p of positions) neighbors.set(p.id, new Set());
  for (const r of graph.relationships) {
    if (neighbors.has(r.source) && neighbors.has(r.target)) {
      neighbors.get(r.source).add(r.target);
      neighbors.get(r.target).add(r.source);
    }
  }

  status.textContent = `${graph.entities.length} entities, ${graph.relationships.length} links`;

  let highlight = null;

  function draw() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // edges
    for (const r of graph.relationships) {
      const a = posById.get(r.source);
      const b = posById.get(r.target);
      if (!a || !b) continue;
      const dim = highlight && highlight !== r.source && highlight !== r.target;
      ctx.strokeStyle = dim ? "rgba(51,65,85,0.35)" : "#334155";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // nodes
    for (const p of positions) {
      const dim = highlight && highlight !== p.id && !neighbors.get(highlight)?.has(p.id);
      ctx.fillStyle = dim ? "rgba(96,165,250,0.3)" : "#60a5fa";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dim ? "rgba(226,232,240,0.35)" : "#e2e8f0";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(p.name).slice(0, 20), p.x, p.y - 10);
    }
  }

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * sx;
    const y = (e.clientY - rect.top) * sy;
    let hit = null;
    for (const p of positions) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy <= 100) { hit = p.id; break; }
    }
    highlight = hit;
    draw();
  });

  draw();
}
