/**
 * Agent Run hero view — 4-pane live dashboard for a single agent session.
 *
 * Layout (2×2 grid, stacks on < 900px):
 *
 *   ┌─────────── Plan ───────────┬──────── Timeline ─────────┐
 *   ├───────── Artifacts ────────┼──────── Approvals ────────┤
 *   └────────────────── footer (status + controls) ─────────┘
 *
 * Stream source: GET {apiBase}/agent/sessions/:id/stream  (Server-Sent Events)
 *
 * Event types consumed:
 *   plan.update, tool.call, tool.result, hitl.request, hitl.resolved,
 *   artifact.new, cost.update, status.change, done
 *
 * Each SSE `data:` frame is a JSON object: { seq, ts, payload }.
 *
 * Usage:
 *   import mount from "/client/src/views/agent-run.js";
 *   mount(document.getElementById("root"), { sessionId: "abc-123" });
 */

const DEFAULT_API_BASE = "/api/v1";
const MAX_TIMELINE_EVENTS = 500;
const CSS_HREF = new URL("./agent-run.css", import.meta.url).href;

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
  if (document.querySelector('link[data-agent-run-css="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.agentRunCss = "1";
  document.head.appendChild(link);
}

function fmtUSD(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.00";
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString();
}

/**
 * @param {HTMLElement} root
 * @param {{ sessionId: string, apiBase?: string }} opts
 * @returns {{ destroy: () => void }}
 */
export default function mount(root, opts) {
  if (!root) throw new Error("mount root required");
  const sessionId = String(opts?.sessionId || "").trim();
  if (!sessionId) throw new Error("opts.sessionId required");
  const apiBase = (opts?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

  ensureStylesheet();

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    status: "connecting",
    iterations: 0,
    costUsd: 0,
    plan: { summary: "", nodes: [] },
    timeline: [],
    artifacts: [],
    approvals: [],
    preview: null,
    pendingApproval: new Set(),
    autoscroll: true,
  };
  let es = null;

  // ─── DOM scaffold ─────────────────────────────────────────────────────────
  const wrap = el("div", { class: "agent-run" });
  wrap.setAttribute("data-session-id", sessionId);

  // Plan pane
  const planSummary = el("div", { class: "ar-plan-summary" });
  const planList = el("ul", { class: "ar-plan-list" });
  const planPane = makePane("Plan", [planSummary, planList]);

  // Timeline pane
  const timelineList = el("ol", { class: "ar-timeline" });
  const timelineScroll = el("div", { class: "ar-timeline-scroll" }, [timelineList]);
  timelineScroll.addEventListener("scroll", () => {
    const nearBottom = timelineScroll.scrollTop + timelineScroll.clientHeight >= timelineScroll.scrollHeight - 16;
    state.autoscroll = nearBottom;
  });
  const timelinePane = makePane("Timeline", [timelineScroll]);

  // Artifacts pane
  const artifactsList = el("ul", { class: "ar-artifacts-list" });
  const artifactPreview = el("div", { class: "ar-artifact-preview", "aria-live": "polite" });
  const artifactsPane = makePane("Artifacts", [artifactsList, artifactPreview]);

  // Approvals pane
  const approvalsList = el("ul", { class: "ar-approvals-list" });
  const approvalsEmpty = el("div", { class: "ar-empty" }, "No pending approvals.");
  const approvalsPane = makePane("Approvals", [approvalsEmpty, approvalsList]);

  const grid = el("div", { class: "ar-grid" }, [planPane, timelinePane, artifactsPane, approvalsPane]);

  // Footer controls
  const statusPill = el("span", { class: "ar-pill ar-pill-connecting" }, "connecting");
  const costEl = el("span", { class: "ar-stat" }, fmtUSD(0));
  const iterEl = el("span", { class: "ar-stat" }, "0 iter");
  const btnPause = el("button", { class: "ar-btn", type: "button" }, "Pause");
  const btnResume = el("button", { class: "ar-btn", type: "button" }, "Resume");
  const btnCancel = el("button", { class: "ar-btn ar-btn-danger", type: "button" }, "Cancel");

  btnPause.addEventListener("click", () => sessionControl("pause"));
  btnResume.addEventListener("click", () => sessionControl("resume"));
  btnCancel.addEventListener("click", () => {
    if (!confirm("Cancel this agent run?")) return;
    sessionControl("cancel");
  });

  const footer = el("div", { class: "ar-footer" }, [
    el("div", { class: "ar-footer-stats" }, [statusPill, costEl, iterEl]),
    el("div", { class: "ar-footer-actions" }, [btnPause, btnResume, btnCancel]),
  ]);

  wrap.appendChild(grid);
  wrap.appendChild(footer);
  root.replaceChildren(wrap);

  // ─── Renderers ────────────────────────────────────────────────────────────

  function renderPlan() {
    planSummary.textContent = state.plan.summary || "";
    planList.replaceChildren();
    const nodes = Array.isArray(state.plan.nodes) ? state.plan.nodes : [];
    if (!nodes.length) {
      planList.appendChild(el("li", { class: "ar-empty" }, "No plan yet."));
      return;
    }
    for (const node of nodes) {
      const status = String(node.status || "pending").toLowerCase();
      const badge = el("span", { class: `ar-badge ar-badge-${status}` }, status);
      const title = el("span", { class: "ar-plan-node-title" }, node.title || node.id || "step");
      const meta = node.detail ? el("span", { class: "ar-plan-node-meta" }, String(node.detail)) : null;
      planList.appendChild(el("li", { class: "ar-plan-node" }, [badge, title, meta]));
    }
  }

  function renderTimeline() {
    const items = state.timeline.slice(-MAX_TIMELINE_EVENTS);
    timelineList.replaceChildren();
    for (const ev of items) {
      const t = el("span", { class: "ar-timeline-time" }, fmtTime(ev.ts));
      const k = el("span", { class: `ar-timeline-kind ar-kind-${cssSafe(ev.type)}` }, ev.type);
      const summary = el("span", { class: "ar-timeline-summary" }, summarize(ev));
      const li = el("li", { class: "ar-timeline-item" }, [t, k, summary]);
      timelineList.appendChild(li);
    }
    if (state.autoscroll) {
      timelineScroll.scrollTop = timelineScroll.scrollHeight;
    }
  }

  function renderArtifacts() {
    artifactsList.replaceChildren();
    if (!state.artifacts.length) {
      artifactsList.appendChild(el("li", { class: "ar-empty" }, "No artifacts yet."));
    }
    for (const art of state.artifacts) {
      const btn = el(
        "button",
        { type: "button", class: "ar-artifact-btn" },
        [
          el("span", { class: "ar-artifact-name" }, art.name || art.id || "artifact"),
          art.mime ? el("span", { class: "ar-artifact-mime" }, art.mime) : null,
        ],
      );
      btn.addEventListener("click", () => openPreview(art));
      artifactsList.appendChild(el("li", null, btn));
    }
    renderPreview();
  }

  function renderPreview() {
    artifactPreview.replaceChildren();
    const a = state.preview;
    if (!a) {
      artifactPreview.appendChild(el("div", { class: "ar-empty" }, "Click an artifact to preview."));
      return;
    }
    const mime = String(a.mime || "").toLowerCase();
    const header = el("div", { class: "ar-artifact-preview-head" }, [
      el("strong", null, a.name || a.id || "artifact"),
      el("button", { type: "button", class: "ar-btn ar-btn-sm", onClick: () => { state.preview = null; renderPreview(); } }, "Close"),
    ]);
    artifactPreview.appendChild(header);
    if (mime.startsWith("image/") && a.url) {
      artifactPreview.appendChild(el("img", { src: a.url, alt: a.name || "image", class: "ar-artifact-image" }));
      return;
    }
    if (mime.includes("json")) {
      let txt;
      try {
        txt = JSON.stringify(typeof a.content === "string" ? JSON.parse(a.content) : a.content, null, 2);
      } catch {
        txt = String(a.content ?? "");
      }
      artifactPreview.appendChild(el("pre", { class: "ar-artifact-text" }, txt));
      return;
    }
    const text = typeof a.content === "string" ? a.content : JSON.stringify(a.content ?? "", null, 2);
    artifactPreview.appendChild(el("pre", { class: "ar-artifact-text" }, text));
  }

  function renderApprovals() {
    approvalsList.replaceChildren();
    const pending = state.approvals.filter((a) => !a.resolved);
    approvalsEmpty.style.display = pending.length ? "none" : "";
    for (const a of pending) {
      const inFlight = state.pendingApproval.has(a.approvalId);
      const summary = el("div", { class: "ar-approval-summary" }, a.summary || a.tool || "Approval requested");
      const meta = a.detail ? el("div", { class: "ar-approval-meta" }, String(a.detail)) : null;
      const approve = el("button", { type: "button", class: "ar-btn ar-btn-ok", disabled: inFlight ? "disabled" : null }, "Approve");
      const deny = el("button", { type: "button", class: "ar-btn ar-btn-danger", disabled: inFlight ? "disabled" : null }, "Deny");
      approve.addEventListener("click", () => decide(a, "approve"));
      deny.addEventListener("click", () => decide(a, "deny"));
      const actions = el("div", { class: "ar-approval-actions" }, [approve, deny]);
      approvalsList.appendChild(el("li", { class: "ar-approval" }, [summary, meta, actions]));
    }
  }

  function renderFooter() {
    statusPill.textContent = state.status;
    statusPill.className = `ar-pill ar-pill-${cssSafe(state.status)}`;
    costEl.textContent = fmtUSD(state.costUsd);
    iterEl.textContent = `${state.iterations} iter`;
  }

  // ─── Approval action ──────────────────────────────────────────────────────

  async function decide(approval, decision) {
    const id = approval.approvalId;
    if (!id || state.pendingApproval.has(id)) return;
    state.pendingApproval.add(id);
    renderApprovals();
    try {
      const resp = await fetch(`${apiBase}/agent/hitl/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ decision }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.warn("[agent-run] hitl decision failed", resp.status, text);
        // Roll back the in-flight guard so the user can retry.
        state.pendingApproval.delete(id);
        renderApprovals();
        return;
      }
      approval.resolved = true;
      state.pendingApproval.delete(id);
      renderApprovals();
    } catch (err) {
      console.warn("[agent-run] hitl decision error", err);
      state.pendingApproval.delete(id);
      renderApprovals();
    }
  }

  // ─── Session control ──────────────────────────────────────────────────────

  async function sessionControl(action) {
    try {
      const resp = await fetch(
        `${apiBase}/agent/sessions/${encodeURIComponent(sessionId)}/${action}`,
        { method: "POST", credentials: "include" },
      );
      if (!resp.ok) console.warn(`[agent-run] ${action} failed`, resp.status);
    } catch (err) {
      console.warn(`[agent-run] ${action} error`, err);
    }
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  function summarize(ev) {
    const p = ev.payload || {};
    if (ev.type === "tool.call") return `${p.tool || p.name || "tool"}(${p.arguments ? "…" : ""})`;
    if (ev.type === "tool.result") return `${p.tool || p.name || "tool"} → ${truncate(p.result)}`;
    if (ev.type === "plan.update") return p.summary || "plan updated";
    if (ev.type === "hitl.request") return `approval: ${p.tool || p.summary || p.approvalId || ""}`;
    if (ev.type === "hitl.resolved") return `resolved: ${p.decision || ""} ${p.approvalId || ""}`;
    if (ev.type === "artifact.new") return `artifact: ${p.name || p.id || ""}`;
    if (ev.type === "cost.update") return `cost: ${fmtUSD(p.totalUsd ?? p.costUsd ?? 0)}`;
    if (ev.type === "status.change") return `${p.status || p.kind || "status"}`;
    if (ev.type === "done") return "run finished";
    return JSON.stringify(p);
  }

  function truncate(v, n = 80) {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return s.length <= n ? s : `${s.slice(0, n)}…`;
  }

  function handleEvent(type, frame) {
    const payload = frame?.payload || {};
    const ts = frame?.ts || new Date().toISOString();
    state.timeline.push({ type, ts, payload });
    if (state.timeline.length > MAX_TIMELINE_EVENTS * 2) {
      state.timeline.splice(0, state.timeline.length - MAX_TIMELINE_EVENTS);
    }

    if (type === "plan.update") {
      if (typeof payload.summary === "string") state.plan.summary = payload.summary;
      if (payload.planDag && Array.isArray(payload.planDag.nodes)) {
        state.plan.nodes = payload.planDag.nodes;
      } else if (Array.isArray(payload.nodes)) {
        state.plan.nodes = payload.nodes;
      }
      renderPlan();
    } else if (type === "tool.call" || type === "tool.result") {
      state.iterations += type === "tool.call" ? 1 : 0;
      renderFooter();
    } else if (type === "artifact.new") {
      const art = {
        id: payload.id || `a_${state.artifacts.length + 1}`,
        name: payload.name,
        mime: payload.mime,
        url: payload.url,
        content: payload.content,
      };
      state.artifacts.push(art);
      renderArtifacts();
    } else if (type === "hitl.request") {
      state.approvals.push({
        approvalId: payload.approvalId || payload.id,
        tool: payload.tool,
        summary: payload.summary,
        detail: payload.detail,
        resolved: false,
      });
      renderApprovals();
    } else if (type === "hitl.resolved") {
      const id = payload.approvalId || payload.id;
      for (const a of state.approvals) if (a.approvalId === id) a.resolved = true;
      renderApprovals();
    } else if (type === "cost.update") {
      const usd = Number(payload.totalUsd ?? payload.costUsd);
      if (Number.isFinite(usd)) state.costUsd = usd;
      renderFooter();
    } else if (type === "status.change") {
      if (payload.status) state.status = String(payload.status);
      renderFooter();
    } else if (type === "done") {
      state.status = "done";
      renderFooter();
    }

    renderTimeline();
  }

  function openPreview(art) {
    state.preview = art;
    renderPreview();
  }

  // ─── EventSource subscription ─────────────────────────────────────────────

  function connect() {
    try { if (es) es.close(); } catch (_) {}
    state.status = "connecting";
    renderFooter();
    const url = `${apiBase}/agent/sessions/${encodeURIComponent(sessionId)}/stream`;
    es = new EventSource(url, { withCredentials: true });
    const types = [
      "plan.update",
      "tool.call",
      "tool.result",
      "hitl.request",
      "hitl.resolved",
      "artifact.new",
      "cost.update",
      "status.change",
      "done",
    ];
    for (const t of types) {
      es.addEventListener(t, (ev) => {
        let frame = null;
        try { frame = JSON.parse(ev.data); } catch { /* ignore */ }
        handleEvent(t, frame);
      });
    }
    es.onerror = () => {
      state.status = "disconnected";
      renderFooter();
    };
    es.onopen = () => {
      if (state.status === "connecting" || state.status === "disconnected") {
        state.status = "live";
        renderFooter();
      }
    };
  }

  connect();
  renderPlan();
  renderTimeline();
  renderArtifacts();
  renderApprovals();
  renderFooter();

  return {
    destroy() {
      try { if (es) es.close(); } catch (_) {}
      es = null;
      root.replaceChildren();
    },
  };
}

function makePane(title, children) {
  return el("section", { class: "ar-pane" }, [
    el("header", { class: "ar-pane-head" }, title),
    el("div", { class: "ar-pane-body" }, children),
  ]);
}

function cssSafe(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
