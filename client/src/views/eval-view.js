/**
 * Eval runner view for the SiskelBot SPA shell. Read-and-run port of the
 * legacy `client/eval.html` page.
 *
 * Two-pane layout:
 *   - Left: list of eval sets from `GET /api/v1/eval/sets`.
 *   - Right: detail panel for the selected set with a "Run" button that
 *     POSTs to `/api/v1/eval/run` and renders the pass/fail/skip summary
 *     plus a per-case result table inline.
 *
 * Pure helpers (`formatEvalStatus`, `summarizeRun`, `sortEvalSets`) are
 * exported as named exports for JSDOM-free unit testing.
 *
 * WIRING (one-liner for client/src/app.js route table):
 *   router.register("/eval", mountInto(() => import("./views/eval-view.js")));
 *
 * Out of scope for this PR (intentional TODOs):
 *   - TODO: create / edit / upload eval sets (read-only listing for now).
 *   - TODO: eval-judge UI (LLM-as-judge scoring surface).
 *   - TODO: staging traces browser — legacy page has a "Staging trace files"
 *     panel backed by `GET /api/v1/eval/staging-traces`; omitted here.
 */

const DEFAULT_API_BASE = "/api/v1";
const CSS_HREF = new URL("./eval-view.css", import.meta.url).href;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Map a per-case eval result to `{ label, cls, symbol }` for rendering.
 * Inputs are objects shaped like
 *   { pass?: boolean, skipped?: boolean, error?: string }
 * Exposed for tests.
 *
 * @param {object|null|undefined} res
 * @returns {{ label: string, cls: string, symbol: string }}
 */
export function formatEvalStatus(res) {
  if (!res || typeof res !== "object") {
    return { label: "unknown", cls: "eval-badge eval-badge-muted", symbol: "?" };
  }
  if (res.skipped) {
    return { label: "skipped", cls: "eval-badge eval-badge-muted", symbol: "–" };
  }
  if (res.pass === true) {
    return { label: "pass", cls: "eval-badge eval-badge-ok", symbol: "\u2713" };
  }
  if (res.pass === false) {
    return { label: "fail", cls: "eval-badge eval-badge-bad", symbol: "\u2717" };
  }
  return { label: "unknown", cls: "eval-badge eval-badge-muted", symbol: "?" };
}

/**
 * Summarize a run response into `{ total, passed, failed, skipped, durationMs }`.
 * Tolerates missing counts by deriving them from the `results` array.
 * Always returns non-negative integers; durationMs defaults to 0.
 * Pure — does not mutate input. Exposed for tests.
 *
 * @param {object|null|undefined} run
 */
export function summarizeRun(run) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const derivedTotal = results.length;
  const derivedPassed = results.filter((r) => r && r.pass === true && !r.skipped).length;
  const derivedSkipped = results.filter((r) => r && r.skipped).length;

  const total = toNonNegInt(run?.total, derivedTotal);
  const passed = toNonNegInt(run?.passed, derivedPassed);
  const skipped = toNonNegInt(run?.skipped, derivedSkipped);
  // Failed = total - passed - skipped, but never negative.
  const failedRaw = total - passed - skipped;
  const failed = failedRaw > 0 ? failedRaw : 0;
  const durationMs = toNonNegInt(run?.durationMs, 0);

  return { total, passed, failed, skipped, durationMs };
}

function toNonNegInt(v, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Stable sort over an eval-set array, newest-name-last by default.
 *
 * Order: `name` asc (locale-aware, case-insensitive), ties broken by `id`
 * asc, ties broken by original input index. Returns a new array; input is
 * not mutated. Non-array inputs return []. Exposed for tests.
 *
 * @param {Array<{ id?: string, name?: string }>|null|undefined} sets
 */
export function sortEvalSets(sets) {
  if (!Array.isArray(sets)) return [];
  const indexed = sets.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const na = String(a.s?.name || a.s?.id || "").toLowerCase();
    const nb = String(b.s?.name || b.s?.id || "").toLowerCase();
    const nCmp = na.localeCompare(nb);
    if (nCmp !== 0) return nCmp;
    const ia = String(a.s?.id || "");
    const ib = String(b.s?.id || "");
    const iCmp = ia.localeCompare(ib);
    if (iCmp !== 0) return iCmp;
    return a.i - b.i;
  });
  return indexed.map((x) => x.s);
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  if (children != null) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-eval-view="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-eval-view", "1");
  document.head.appendChild(link);
}

function truncate(s, max) {
  const str = String(s == null ? "" : s);
  if (str.length <= max) return str;
  return str.slice(0, max) + "\u2026";
}

// ── Mount ────────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} root
 * @param {{
 *   apiBase?: string,
 *   fetchImpl?: typeof fetch,
 *   workspace?: string,
 * }} [ctx]
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export default function mount(root, ctx = {}) {
  if (!root) throw new Error("mount root required");
  const apiBase = (ctx.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  ensureStylesheet();

  const state = {
    sets: [],
    selectedId: null,
    loadingSets: false,
    running: false,
    run: null,           // last run response
    error: null,
    destroyed: false,
  };

  // ── Scaffold ──────────────────────────────────────────────────────────────
  const status = el("span", { class: "eval-pill eval-pill-loading" }, "loading\u2026");
  const header = el("header", { class: "eval-header" }, [
    el("h1", { class: "eval-title", id: "eval-view-title" }, "Eval runner"),
    el("span", { class: "eval-subtitle" }, "read-and-run"),
    status,
  ]);

  const refreshBtn = el("button", { class: "eval-btn", type: "button" }, "Refresh");
  refreshBtn.addEventListener("click", () => { refresh().catch(() => {}); });

  const listEmpty = el("div", { class: "eval-empty", hidden: "hidden" }, "");
  const listUl = el("ul", { class: "eval-list", role: "listbox", "aria-label": "Eval sets" });

  const leftPane = el("aside", { class: "eval-pane eval-pane-left" }, [
    el("div", { class: "eval-pane-header" }, [
      el("h2", { class: "eval-pane-title" }, "Eval sets"),
      refreshBtn,
    ]),
    listEmpty,
    listUl,
  ]);

  const detail = el("div", { class: "eval-detail" });
  const rightPane = el("section", { class: "eval-pane eval-pane-right" }, detail);

  const errorBar = el("div", { class: "eval-error", role: "alert", hidden: "hidden" });

  const wrap = el("section", { class: "eval-view", "aria-labelledby": "eval-view-title" }, [
    header,
    errorBar,
    el("div", { class: "eval-split" }, [leftPane, rightPane]),
  ]);
  root.replaceChildren(wrap);

  renderDetail();

  // ── Rendering ─────────────────────────────────────────────────────────────
  function setStatusPill(text, cls) {
    status.textContent = text;
    status.className = "eval-pill " + cls;
  }

  function setError(err) {
    state.error = err || null;
    if (!err) {
      errorBar.hidden = true;
      errorBar.textContent = "";
    } else {
      errorBar.hidden = false;
      errorBar.textContent = `Error: ${err.message || err}`;
    }
  }

  function renderList() {
    listUl.replaceChildren();
    const sorted = sortEvalSets(state.sets);
    if (sorted.length === 0) {
      listEmpty.hidden = false;
      listEmpty.textContent = state.loadingSets
        ? "Loading\u2026"
        : "No eval sets found. Drop JSON files in data/eval-sets/.";
      return;
    }
    listEmpty.hidden = true;
    for (const s of sorted) {
      const selected = s.id === state.selectedId;
      const li = el("li", {
        class: "eval-list-item" + (selected ? " eval-list-item-active" : ""),
        role: "option",
        "aria-selected": selected ? "true" : "false",
        tabindex: "0",
        dataset: { id: s.id },
      }, [
        el("div", { class: "eval-list-name" }, s.name || s.id),
        el("div", { class: "eval-list-id" }, s.id),
      ]);
      li.addEventListener("click", () => { selectSet(s.id); });
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectSet(s.id);
        }
      });
      listUl.appendChild(li);
    }
  }

  function renderDetail() {
    detail.replaceChildren();
    if (!state.selectedId) {
      detail.appendChild(el("div", { class: "eval-empty" }, "Select an eval set to run."));
      return;
    }
    const meta = state.sets.find((s) => s && s.id === state.selectedId);
    const name = meta?.name || state.selectedId;

    const runBtn = el("button", {
      class: "eval-btn eval-btn-primary",
      type: "button",
    }, state.running ? "Running\u2026" : "Run eval");
    if (state.running) runBtn.setAttribute("disabled", "disabled");
    runBtn.addEventListener("click", () => { runSelected().catch((e) => setError(e)); });

    detail.appendChild(el("div", { class: "eval-detail-header" }, [
      el("h2", { class: "eval-detail-title" }, name),
      el("span", { class: "eval-detail-id" }, state.selectedId),
      el("span", { class: "eval-detail-spacer" }),
      runBtn,
    ]));

    if (state.running) {
      detail.appendChild(el("div", { class: "eval-status-bar" }, "Running eval set\u2026 this may take a while."));
    }

    if (state.run) {
      detail.appendChild(renderRunSummary(state.run));
      detail.appendChild(renderResultsTable(state.run));
    } else if (!state.running) {
      detail.appendChild(el("div", { class: "eval-hint" }, "Press Run to execute this eval set against the configured backend."));
    }
  }

  function renderRunSummary(run) {
    const s = summarizeRun(run);
    const wrapEl = el("div", { class: "eval-summary" }, [
      el("span", { class: "eval-summary-main" }, [
        el("strong", { class: "eval-pass" }, String(s.passed)),
        " passed of ",
        el("strong", null, String(s.total)),
        " cases",
      ]),
      el("span", { class: "eval-summary-meta" }, [
        el("span", { class: "eval-fail" }, `${s.failed} failed`),
        el("span", { class: "eval-muted" }, `${s.skipped} skipped`),
        el("span", { class: "eval-muted" }, `${s.durationMs} ms`),
      ]),
    ]);
    return wrapEl;
  }

  function renderResultsTable(run) {
    const results = Array.isArray(run?.results) ? run.results : [];
    if (results.length === 0) {
      return el("div", { class: "eval-empty" }, "No per-case results in the response.");
    }
    const tbody = el("tbody");
    for (const r of results) {
      const meta = formatEvalStatus(r);
      tbody.appendChild(el("tr", null, [
        el("td", { class: "eval-case-id" }, String(r?.caseId || "")),
        el("td", null, el("span", { class: meta.cls, title: meta.label }, `${meta.symbol} ${meta.label}`)),
        el("td", { class: "eval-cell-output" }, truncate(r?.output, 200)),
        el("td", { class: "eval-cell-activity" }, truncate(r?.agentActivityHint, 200)),
        el("td", { class: "eval-cell-error" }, truncate(r?.error || r?.reason, 200)),
      ]));
    }
    return el("table", { class: "eval-table" }, [
      el("thead", null, el("tr", null, [
        el("th", { scope: "col" }, "Case"),
        el("th", { scope: "col" }, "Result"),
        el("th", { scope: "col" }, "Output"),
        el("th", { scope: "col" }, "Activity"),
        el("th", { scope: "col" }, "Error / Reason"),
      ])),
      tbody,
    ]);
  }

  function selectSet(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    state.run = null; // clear stale results when switching
    renderList();
    renderDetail();
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function refresh() {
    if (state.destroyed) return;
    if (!fetchImpl) {
      setStatusPill("offline", "eval-pill-bad");
      setError(new Error("fetch not available"));
      return;
    }
    state.loadingSets = true;
    setStatusPill("loading\u2026", "eval-pill-loading");
    renderList();
    try {
      const resp = await fetchImpl(`${apiBase}/eval/sets`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          state.sets = [];
          setStatusPill("signed out", "eval-pill-muted");
          setError(null);
          renderList();
          renderDetail();
          return;
        }
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || body?.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      state.sets = Array.isArray(data?.sets) ? data.sets : [];
      setError(null);
      // Keep selection if still in list; else clear.
      if (state.selectedId && !state.sets.some((s) => s && s.id === state.selectedId)) {
        state.selectedId = null;
        state.run = null;
      }
      setStatusPill(`updated ${new Date().toLocaleTimeString()}`, "eval-pill-ok");
      renderList();
      renderDetail();
    } catch (err) {
      setStatusPill("error", "eval-pill-bad");
      setError(err);
    } finally {
      state.loadingSets = false;
    }
  }

  async function runSelected() {
    if (!state.selectedId || state.running) return;
    if (!fetchImpl) { setError(new Error("fetch not available")); return; }
    state.running = true;
    state.run = null;
    setError(null);
    setStatusPill("running\u2026", "eval-pill-loading");
    renderDetail();
    try {
      const resp = await fetchImpl(`${apiBase}/eval/run`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ evalSetId: state.selectedId }),
      });
      const data = await safeJson(resp);
      if (!resp.ok) {
        throw new Error(data?.error?.message || data?.error || `HTTP ${resp.status}`);
      }
      state.run = data || {};
      const s = summarizeRun(state.run);
      setStatusPill(`${s.passed}/${s.total} passed`, s.failed === 0 ? "eval-pill-ok" : "eval-pill-bad");
    } catch (err) {
      setStatusPill("error", "eval-pill-bad");
      setError(err);
    } finally {
      state.running = false;
      renderDetail();
    }
  }

  async function safeJson(resp) {
    try { return await resp.json(); } catch (_) { return null; }
  }

  // Kick off initial fetch.
  refresh().catch(() => {});

  return {
    refresh,
    destroy() {
      state.destroyed = true;
      try { root.replaceChildren(); } catch (_) { /* ignore */ }
    },
  };
}
