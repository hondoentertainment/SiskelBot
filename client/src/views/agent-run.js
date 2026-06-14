/**
 * Agent Run hero view — 5-pane live dashboard for a single agent session.
 *
 * Desktop layout (>= 1200px, 2 columns):
 *
 *   ┌─────── Plan ───────┬──────── Timeline ─────────┐
 *   ├─────── Tree ───────┤                            │
 *   │                    ├──────── Artifacts ─────────┤
 *   │                    ├──────── Approvals ─────────┤
 *   └────────────────── footer (status + controls) ───┘
 *
 * Medium (< 1200px): Plan > Tree (collapsible) > Timeline > Artifacts > Approvals
 * Mobile  (< 900px): All sections stack vertically
 *
 * Stream source: GET {apiBase}/agent/sessions/:id/stream  (Server-Sent Events)
 *
 * Event types consumed:
 *   plan.update, tool.call, tool.result, hitl.request, hitl.resolved,
 *   artifact.new, cost.update, status.change, subagent.spawned,
 *   subagent.done, done
 *
 * Each SSE `data:` frame is a JSON object: { seq, ts, payload }.
 *
 * Usage:
 *   import mount from "/client/src/views/agent-run.js";
 *   mount(document.getElementById("root"), { sessionId: "abc-123" });
 */

import { renderTrajectoryTree } from "./inspector-content.js";
import { buildTree, renderTreeHtml, updateNodeInTree } from "./subagent-tree.js";

const DEFAULT_API_BASE = "/api/v1";
const MAX_TIMELINE_EVENTS = 500;
const CSS_HREF = new URL("./agent-run.css", import.meta.url).href;
const ARTIFACT_TEXT_PREVIEW_BYTES = 20 * 1024; // truncate text / json previews at 20 KB

function pushTrajectoryToInspector(events) {
  try {
    const ins = globalThis.SiskelbotShell?.inspector;
    if (!ins) return;
    ins.setTitle?.("Trajectory");
    ins.setContent?.(renderTrajectoryTree(events));
  } catch { /* noop */ }
}

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

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function mimeCategory(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/json" || m.endsWith("+json")) return "json";
  if (m.startsWith("text/") || m === "application/xml" || m.endsWith("+xml")) return "text";
  return "other";
}

function mimeIcon(cat) {
  if (cat === "image") return "\u{1F5BC}"; // framed picture
  if (cat === "json") return "{}";
  if (cat === "text") return "\u{1F4C4}"; // document
  return "\u{1F4E6}"; // package
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
    treeEvents: [],
    tree: null,
    treeCollapsed: new Set(),
  };
  let es = null;
  let previewRequestSeq = 0;
  const knownArtifactIds = new Set();
  let artifactsBackfilled = false;

  // ─── DOM scaffold ─────────────────────────────────────────────────────────
  const wrap = el("div", { class: "agent-run" });
  wrap.setAttribute("data-session-id", sessionId);

  // Plan pane
  const planSummary = el("div", { class: "ar-plan-summary" });
  const planList = el("ul", { class: "ar-plan-list" });
  const planPane = makePane("Plan", [planSummary, planList]);

  // Tree pane (subagent hierarchy)
  const treeContainer = el("div", { class: "sat-tree" });
  const treePane = makePane("Tree", [treeContainer]);

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

  const grid = el("div", { class: "ar-grid" }, [planPane, timelinePane, treePane, artifactsPane, approvalsPane]);

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

  function renderTree() {
    state.tree = buildTree(state.treeEvents, { sessionId, title: sessionId });
    const html = renderTreeHtml(state.tree, 0, state.treeCollapsed);
    treeContainer.innerHTML = html ? `<ul class="sat-root">${html}</ul>` : '<div class="ar-empty">No subagents spawned.</div>';
    // Bind toggle clicks
    for (const toggle of treeContainer.querySelectorAll(".sat-toggle")) {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const nodeId = toggle.dataset.nodeId;
        if (!nodeId) return;
        if (state.treeCollapsed.has(nodeId)) {
          state.treeCollapsed.delete(nodeId);
        } else {
          state.treeCollapsed.add(nodeId);
        }
        renderTree();
      });
    }
    // Bind click-to-navigate on nodes
    for (const node of treeContainer.querySelectorAll(".sat-node")) {
      const sid = node.dataset.sessionId;
      if (!sid || sid === sessionId) continue;
      node.addEventListener("click", () => {
        const shell = globalThis.SiskelbotShell;
        if (shell?.navigate) {
          shell.navigate(`/runs/${encodeURIComponent(sid)}`);
        } else {
          window.open(`/runs/${encodeURIComponent(sid)}`, "_blank", "noopener");
        }
      });
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
      const cat = mimeCategory(art.mime);
      const icon = el("span", { class: "ar-artifact-icon", "aria-hidden": "true" }, mimeIcon(cat));
      const nameNode = el("span", { class: "ar-artifact-name" }, art.name || art.id || "artifact");
      const metaBits = [];
      if (art.mime) metaBits.push(art.mime);
      const sizeText = fmtBytes(art.sizeBytes);
      if (sizeText) metaBits.push(sizeText);
      const meta = metaBits.length
        ? el("span", { class: "ar-artifact-mime" }, metaBits.join(" \u00b7 "))
        : null;
      const btn = el(
        "button",
        { type: "button", class: `ar-artifact-btn ar-artifact-cat-${cat}` },
        [icon, nameNode, meta],
      );
      btn.addEventListener("click", () => openPreview(art));
      artifactsList.appendChild(el("li", null, btn));
    }
    renderPreview();
  }

  function artifactUrl(a) {
    if (a && typeof a.url === "string" && a.url) return a.url;
    if (a && a.id) return `${apiBase}/agent/artifacts/${encodeURIComponent(a.id)}`;
    return null;
  }

  async function fetchArtifactText(a, { full = false } = {}) {
    const url = artifactUrl(a);
    if (!url) return null;
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (!full && bytes.length > ARTIFACT_TEXT_PREVIEW_BYTES) {
        const slice = bytes.subarray(0, ARTIFACT_TEXT_PREVIEW_BYTES);
        return { text: new TextDecoder().decode(slice), truncated: true, totalBytes: bytes.length };
      }
      return { text: new TextDecoder().decode(bytes), truncated: false, totalBytes: bytes.length };
    } catch {
      return null;
    }
  }

  function renderPreview() {
    artifactPreview.replaceChildren();
    const a = state.preview;
    if (!a) {
      artifactPreview.appendChild(el("div", { class: "ar-empty" }, "Click an artifact to preview."));
      return;
    }
    const cat = mimeCategory(a.mime);
    const url = artifactUrl(a);
    const headBits = [
      el("strong", null, a.name || a.id || "artifact"),
    ];
    const metaBits = [];
    if (a.mime) metaBits.push(a.mime);
    const sizeText = fmtBytes(a.sizeBytes);
    if (sizeText) metaBits.push(sizeText);
    if (metaBits.length) {
      headBits.push(el("span", { class: "ar-artifact-mime" }, metaBits.join(" \u00b7 ")));
    }
    if (url) {
      headBits.push(
        el(
          "a",
          { href: url, download: a.name || a.id || "artifact", class: "ar-btn ar-btn-sm", target: "_blank", rel: "noopener" },
          "Download",
        ),
      );
    }
    headBits.push(
      el(
        "button",
        {
          type: "button",
          class: "ar-btn ar-btn-sm",
          onClick: () => { state.preview = null; renderPreview(); },
        },
        "Close",
      ),
    );
    const header = el("div", { class: "ar-artifact-preview-head" }, headBits);
    artifactPreview.appendChild(header);

    if (cat === "image" && url) {
      artifactPreview.appendChild(
        el("img", { src: url, alt: a.name || "image", class: "ar-artifact-image" }),
      );
      return;
    }

    if (cat === "text" || cat === "json") {
      const pre = el("pre", { class: "ar-artifact-text" }, "Loading\u2026");
      artifactPreview.appendChild(pre);
      const requestId = ++previewRequestSeq;
      fetchArtifactText(a, { full: false }).then((res) => {
        if (requestId !== previewRequestSeq || state.preview !== a) return;
        if (!res) { pre.textContent = "(failed to load preview)"; return; }
        let body = res.text;
        if (cat === "json") {
          try { body = JSON.stringify(JSON.parse(res.text), null, 2); } catch { /* keep raw */ }
        }
        pre.textContent = body;
        if (res.truncated) {
          const loadFull = el(
            "button",
            { type: "button", class: "ar-btn ar-btn-sm" },
            `Load full (${fmtBytes(res.totalBytes)})`,
          );
          loadFull.addEventListener("click", async () => {
            loadFull.disabled = true;
            loadFull.textContent = "Loading\u2026";
            const fullRes = await fetchArtifactText(a, { full: true });
            if (state.preview !== a) return;
            if (!fullRes) { loadFull.textContent = "Failed"; return; }
            let fullBody = fullRes.text;
            if (cat === "json") {
              try { fullBody = JSON.stringify(JSON.parse(fullRes.text), null, 2); } catch { /* keep raw */ }
            }
            pre.textContent = fullBody;
            loadFull.remove();
          });
          artifactPreview.appendChild(loadFull);
        }
      });
      return;
    }

    // Non-previewable mime types: surface as a download link.
    const linkRow = el("div", { class: "ar-artifact-download" });
    if (url) {
      linkRow.appendChild(
        el(
          "a",
          { href: url, download: a.name || a.id || "artifact", target: "_blank", rel: "noopener" },
          `Download ${a.name || "artifact"}`,
        ),
      );
    } else {
      linkRow.appendChild(el("span", { class: "ar-empty" }, "Preview unavailable."));
    }
    artifactPreview.appendChild(linkRow);
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
      const errorNode = a.error
        ? el("div", { class: "ar-approval-error", role: "alert" }, String(a.error))
        : null;
      approvalsList.appendChild(el("li", { class: "ar-approval" }, [summary, meta, errorNode, actions]));
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
    approval.error = null;
    renderApprovals();
    try {
      const resp = await fetch(`${apiBase}/agent/hitl/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ decision }),
      });
      if (!resp.ok) {
        let bodyText = "";
        try { bodyText = await resp.text(); } catch { /* ignore */ }
        let errMsg = `${resp.status} ${resp.statusText || "request failed"}`;
        try {
          const j = bodyText ? JSON.parse(bodyText) : null;
          if (j && (j.error || j.message)) errMsg = String(j.error || j.message);
        } catch { /* body was not JSON */ }
        console.warn("[agent-run] hitl decision failed", resp.status, bodyText);
        approval.error = `Could not ${decision}: ${errMsg}`;
        // Roll back the in-flight guard so the user can retry.
        state.pendingApproval.delete(id);
        renderApprovals();
        return;
      }
      // Optimistically retire the card. The hitl.resolved SSE frame will
      // arrive shortly to confirm (and idempotently mark resolved=true again).
      approval.resolved = true;
      approval.error = null;
      state.pendingApproval.delete(id);
      renderApprovals();
    } catch (err) {
      console.warn("[agent-run] hitl decision error", err);
      approval.error = `Network error while sending ${decision}`;
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

  // ─── Artifact backfill ────────────────────────────────────────────────────

  async function backfillArtifacts() {
    if (artifactsBackfilled) return;
    artifactsBackfilled = true;
    try {
      const resp = await fetch(
        `${apiBase}/agent/sessions/${encodeURIComponent(sessionId)}/artifacts`,
        { credentials: "include" },
      );
      if (!resp.ok) return;
      const data = await resp.json().catch(() => null);
      const items = Array.isArray(data?.items) ? data.items : [];
      let changed = false;
      // Session list is newest-first; preserve that on paint.
      for (const rec of items) {
        const id = rec?.id;
        if (!id || knownArtifactIds.has(id)) continue;
        knownArtifactIds.add(id);
        state.artifacts.push({
          id,
          name: rec.name,
          mime: rec.mime,
          sizeBytes: rec.sizeBytes,
          url: `${apiBase}/agent/artifacts/${encodeURIComponent(id)}`,
        });
        changed = true;
      }
      if (changed) renderArtifacts();
    } catch {
      // Best-effort backfill; live SSE will still populate new items.
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
    if (ev.type === "subagent.spawned") return `spawned: ${p.profile || "agent"} ${p.childSessionId || ""}`;
    if (ev.type === "subagent.done") return `child done: ${p.childSessionId || ""} ${p.error ? "(error)" : ""}`;
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
      if (type === "tool.call") state.treeEvents.push({ type, payload });
      renderFooter();
    } else if (type === "artifact.new") {
      const id = payload.id || `a_${state.artifacts.length + 1}`;
      if (!knownArtifactIds.has(id)) {
        const art = {
          id,
          name: payload.name,
          mime: payload.mime,
          sizeBytes: payload.sizeBytes,
          url: payload.url,
          content: payload.content,
        };
        knownArtifactIds.add(id);
        // Prepend so the latest artifact is at the top of the pane.
        state.artifacts.unshift(art);
        renderArtifacts();
      }
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
    } else if (type === "subagent.spawned") {
      state.treeEvents.push({ type, payload });
      renderTree();
    } else if (type === "subagent.done") {
      state.treeEvents.push({ type, payload });
      renderTree();
    } else if (type === "cost.update") {
      const usd = Number(payload.totalUsd ?? payload.costUsd);
      if (Number.isFinite(usd)) state.costUsd = usd;
      // Forward cost.update with childCostUsd to tree state
      if (payload.childSessionId && payload.childCostUsd != null) {
        state.treeEvents.push({ type, payload });
        renderTree();
      }
      renderFooter();
    } else if (type === "status.change") {
      if (payload.status) state.status = String(payload.status);
      state.treeEvents.push({ type, payload });
      renderFooter();
    } else if (type === "done") {
      state.status = "done";
      renderFooter();
    }

    renderTimeline();
    pushTrajectoryToInspector(state.timeline);
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
      "subagent.spawned",
      "subagent.done",
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
  renderTree();
  renderTimeline();
  renderArtifacts();
  renderApprovals();
  renderFooter();
  // Fire-and-forget backfill of existing artifacts so the pane is populated
  // even when no `artifact.new` SSE frames arrive this connection.
  backfillArtifacts();

  return {
    destroy() {
      try { if (es) es.close(); } catch (_) {}
      es = null;
      try { globalThis.SiskelbotShell?.inspector?.clear(); } catch (_) {}
      try { root.replaceChildren(); } catch (_) {}
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
