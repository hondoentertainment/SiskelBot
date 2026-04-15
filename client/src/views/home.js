/**
 * Home dashboard view for the SiskelBot SPA shell.
 *
 * WIRING — app.js should register this view like so:
 *   router.register("/home", mountInto(() => import("./views/home.js")));
 * (Replace the existing placeholderView("Home", ...) line.)
 *
 * Cards rendered:
 *   1. Recent runs         — GET /api/v1/agent/sessions?workspace=…&limit=5
 *   2. Recent conversations — GET /api/v1/conversations?workspace=…&limit=5
 *   3. Signal strip        — GET /api/v1/signals/composer (backend/model/latency/cost)
 *   4. HITL card           — derived from the sessions response (status==="paused").
 *                            There is no dedicated GET /agent/hitl/pending endpoint
 *                            (only the POST decision resolver at /agent/hitl/:approvalId),
 *                            so we fall back to flagging paused runs. A session whose
 *                            agent loop is waiting on saveHitlState surfaces as "paused"
 *                            to listAgentSessionsForWorkspace.
 *
 * Pure helpers (formatTime, truncate, sortByCreatedAt, pickOpenHitl, formatLatencyMs,
 * formatUsd) are exported for JSDOM-free unit tests.
 */

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_POLL_MS = 15000;
const DEFAULT_LIMIT = 5;
const CSS_HREF = new URL("./home.css", import.meta.url).href;

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Format an ISO-ish timestamp as a short human string.
 * Returns "—" for null/undefined/unparseable input.
 */
export function formatTime(v) {
  if (v === null || v === undefined || v === "") return "—";
  const ms = toMs(v);
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Truncate a string to `n` characters, appending an ellipsis when cut.
 * Handles non-strings gracefully.
 */
export function truncate(str, n) {
  const s = str == null ? "" : String(str);
  const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!max) return "";
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "\u2026";
}

/**
 * Stable sort over rows by createdAt descending (newest first).
 * Returns a new array. Non-array input returns []. Input is not mutated.
 */
export function sortByCreatedAt(rows) {
  if (!Array.isArray(rows)) return [];
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const cmp = toMs(b.r?.createdAt) - toMs(a.r?.createdAt);
    if (cmp !== 0) return cmp;
    return a.i - b.i;
  });
  return indexed.map((x) => x.r);
}

/**
 * From a session list, pick the first row that looks like it needs human
 * approval. Sessions whose agent loop is waiting on saveHitlState surface
 * as status==="paused" (optionally with a truthy awaitingApproval flag).
 * Returns the row object, or null when none.
 */
export function pickOpenHitl(rows) {
  if (!Array.isArray(rows)) return null;
  const sorted = sortByCreatedAt(rows);
  for (const row of sorted) {
    if (!row) continue;
    const status = String(row.status || "").toLowerCase();
    if (row.awaitingApproval === true) return row;
    if (status === "paused") return row;
  }
  return null;
}

/**
 * Format a latency value in milliseconds as "123 ms" or "1.2 s" or "—".
 */
export function formatLatencyMs(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/**
 * Format a USD number as "$0.0042" / "$1.23" / "—".
 */
export function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const digits = abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

function toMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// ─── DOM helpers ───────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
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
  if (document.querySelector('link[data-home-css="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.homeCss = "1";
  document.head.appendChild(link);
}

function navigate(path) {
  try {
    const shell = typeof window !== "undefined" ? window.SiskelbotShell : null;
    if (shell && shell.router && typeof shell.router.navigate === "function") {
      shell.router.navigate(path);
      return;
    }
  } catch (_) { /* fall through */ }
  if (typeof window !== "undefined") {
    window.location.assign("/app#" + path);
  }
}

function rowTitle(row) {
  if (!row) return "Untitled";
  if (row.title) return row.title;
  const plan = row.planSummary || "";
  const line = String(plan).split(/\r?\n/)[0] || "";
  if (line) return line;
  return "Untitled session";
}

function convTitle(row) {
  if (!row) return "Untitled";
  return row.title || row.name || "Untitled conversation";
}

async function safeJson(resp) {
  try { return await resp.json(); } catch (_) { return null; }
}

// ─── Mount ─────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} root
 * @param {{ apiBase?: string, workspace?: string, pollMs?: number, fetchImpl?: typeof fetch, query?: string|URLSearchParams }} [ctx]
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export default function mount(root, ctx = {}) {
  if (!root) throw new Error("mount root required");
  const apiBase = (ctx.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const pollMs = Math.max(2000, Number(ctx.pollMs) || DEFAULT_POLL_MS);
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const queryParams = parseQuery(ctx.query);
  const workspace = String(ctx.workspace || queryParams.get("workspace") || "default");

  ensureStylesheet();

  const state = {
    destroyed: false,
    sessions: [],
    conversations: [],
    signals: null,
    lastUpdated: null,
  };
  let timer = null;

  // ── DOM scaffold ─────────────────────────────────────────────────────────
  const statusPill = el("span", { class: "home-pill home-pill-loading" }, "loading\u2026");
  const header = el("header", { class: "home-header" }, [
    el("h1", { class: "home-title" }, "Home"),
    el("span", { class: "home-subtitle" }, `workspace: ${workspace}`),
    statusPill,
  ]);

  // Signal strip card
  const signalList = el("dl", { class: "home-signal-grid" });
  const signalCard = el("section", { class: "home-card home-card-signals", "aria-labelledby": "home-signals-title" }, [
    el("header", { class: "home-card-head" }, [
      el("h2", { id: "home-signals-title", class: "home-card-title" }, "Signals"),
    ]),
    signalList,
  ]);

  // HITL card (hidden until a pending session is found)
  const hitlBody = el("div", { class: "home-hitl-body" });
  const hitlCard = el("section", { class: "home-card home-card-hitl", "aria-labelledby": "home-hitl-title", hidden: "hidden" }, [
    el("header", { class: "home-card-head" }, [
      el("h2", { id: "home-hitl-title", class: "home-card-title" }, "Approvals"),
    ]),
    hitlBody,
  ]);

  // Recent runs card
  const runsBody = el("div", { class: "home-card-body" });
  const runsCard = el("section", { class: "home-card", "aria-labelledby": "home-runs-title" }, [
    el("header", { class: "home-card-head" }, [
      el("h2", { id: "home-runs-title", class: "home-card-title" }, "Recent runs"),
      el("a", {
        href: "#/runs",
        class: "home-card-link",
        onclick: (e) => { e.preventDefault(); navigate("/runs"); },
      }, "View all \u2192"),
    ]),
    runsBody,
  ]);

  // Recent conversations card
  const convsBody = el("div", { class: "home-card-body" });
  const convsCard = el("section", { class: "home-card", "aria-labelledby": "home-convs-title" }, [
    el("header", { class: "home-card-head" }, [
      el("h2", { id: "home-convs-title", class: "home-card-title" }, "Recent conversations"),
      el("a", {
        href: "#/chat",
        class: "home-card-link",
        onclick: (e) => { e.preventDefault(); navigate("/chat"); },
      }, "Open chat \u2192"),
    ]),
    convsBody,
  ]);

  const grid = el("div", { class: "home-grid" }, [
    signalCard,
    hitlCard,
    runsCard,
    convsCard,
  ]);

  const wrap = el("section", { class: "home-view", "aria-labelledby": "home-view-title" }, [
    header,
    grid,
  ]);
  header.querySelector("h1").id = "home-view-title";

  root.replaceChildren(wrap);

  // ── Rendering ────────────────────────────────────────────────────────────

  function setStatus(text, cls) {
    statusPill.textContent = text;
    statusPill.className = "home-pill " + cls;
  }

  function renderSignals() {
    signalList.replaceChildren();
    const s = state.signals;
    if (!s) {
      signalList.appendChild(el("div", { class: "home-signal-empty" }, "Signals unavailable."));
      return;
    }
    const pairs = [
      ["Backend", s.backend || "\u2014"],
      ["Model", s.model || "\u2014"],
      ["Latency (p50)", formatLatencyMs(Number(s.p50LatencyMs) || 0)],
      ["Est. cost / req", formatUsd(Number(s.estCostUsd) || 0)],
      ["Breaker", s.breakerState || "\u2014"],
    ];
    for (const [k, v] of pairs) {
      signalList.appendChild(el("dt", { class: "home-signal-key" }, k));
      signalList.appendChild(el("dd", { class: "home-signal-val" }, String(v)));
    }
  }

  function renderHitl() {
    const row = pickOpenHitl(state.sessions);
    if (!row) {
      hitlCard.hidden = true;
      return;
    }
    hitlCard.hidden = false;
    hitlBody.replaceChildren();
    hitlBody.appendChild(el("p", { class: "home-hitl-msg" },
      `Session "${truncate(rowTitle(row), 80)}" is waiting for approval.`,
    ));
    const resumeBtn = el("button", {
      class: "home-btn home-btn-primary",
      type: "button",
      onclick: () => navigate("/runs/" + row.id),
    }, "Resume agent run \u2192");
    hitlBody.appendChild(resumeBtn);
  }

  function renderRuns() {
    runsBody.replaceChildren();
    const rows = sortByCreatedAt(state.sessions).slice(0, DEFAULT_LIMIT);
    if (rows.length === 0) {
      runsBody.appendChild(el("p", { class: "home-empty" }, "No agent runs yet."));
      return;
    }
    const list = el("ul", { class: "home-list" });
    for (const row of rows) {
      const li = el("li", {
        class: "home-list-row",
        tabindex: "0",
        role: "link",
        "aria-label": `Open session ${rowTitle(row)}`,
        dataset: { id: row.id },
        onclick: (e) => {
          if (e.target && e.target.closest && e.target.closest("a")) return;
          navigate("/runs/" + row.id);
        },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate("/runs/" + row.id);
          }
        },
      }, [
        el("span", { class: "home-list-title" }, truncate(rowTitle(row), 80)),
        el("span", { class: "home-list-meta" }, [
          el("span", { class: "home-badge home-badge-" + String(row.status || "unknown").toLowerCase() },
            String(row.status || "unknown")),
          el("span", { class: "home-list-ts" }, formatTime(row.createdAt)),
        ]),
      ]);
      list.appendChild(li);
    }
    runsBody.appendChild(list);
  }

  function renderConversations() {
    convsBody.replaceChildren();
    const rows = sortByCreatedAt(state.conversations).slice(0, DEFAULT_LIMIT);
    if (rows.length === 0) {
      convsBody.appendChild(el("p", { class: "home-empty" }, "No conversations yet."));
      return;
    }
    const list = el("ul", { class: "home-list" });
    for (const row of rows) {
      const li = el("li", {
        class: "home-list-row",
        tabindex: "0",
        role: "link",
        "aria-label": `Open conversation ${convTitle(row)}`,
        dataset: { id: row.id },
        onclick: () => navigate("/chat"),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate("/chat");
          }
        },
      }, [
        el("span", { class: "home-list-title" }, truncate(convTitle(row), 80)),
        el("span", { class: "home-list-meta" }, [
          el("span", { class: "home-list-ts" }, formatTime(row.createdAt || row.updatedAt)),
        ]),
      ]);
      list.appendChild(li);
    }
    convsBody.appendChild(list);
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  async function fetchJson(url) {
    if (!fetchImpl) throw new Error("fetch not available");
    const resp = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        return { __unauthorized: true };
      }
      const body = await safeJson(resp);
      throw new Error(body?.error?.message || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async function refresh() {
    if (state.destroyed) return;
    if (!fetchImpl) {
      setStatus("offline", "home-pill-bad");
      return;
    }
    setStatus("refreshing\u2026", "home-pill-loading");
    const wsArg = encodeURIComponent(workspace);
    const limit = DEFAULT_LIMIT;

    const sessionsP = fetchJson(`${apiBase}/agent/sessions?workspace=${wsArg}&limit=${limit}`)
      .catch((err) => ({ __error: err }));
    const convsP = fetchJson(`${apiBase}/conversations?workspace=${wsArg}&limit=${limit}`)
      .catch((err) => ({ __error: err }));
    const signalsP = fetchJson(`${apiBase}/signals/composer`)
      .catch((err) => ({ __error: err }));

    const [sessionsRes, convsRes, signalsRes] = await Promise.all([sessionsP, convsP, signalsP]);
    if (state.destroyed) return;

    let anySignedOut = false;
    let anyError = false;

    if (sessionsRes && sessionsRes.__unauthorized) {
      state.sessions = []; anySignedOut = true;
    } else if (sessionsRes && sessionsRes.__error) {
      state.sessions = []; anyError = true;
    } else {
      state.sessions = Array.isArray(sessionsRes?.items)
        ? sessionsRes.items
        : Array.isArray(sessionsRes) ? sessionsRes : [];
    }

    if (convsRes && convsRes.__unauthorized) {
      state.conversations = []; anySignedOut = true;
    } else if (convsRes && convsRes.__error) {
      state.conversations = []; anyError = true;
    } else {
      state.conversations = Array.isArray(convsRes?.items)
        ? convsRes.items
        : Array.isArray(convsRes) ? convsRes : [];
    }

    if (signalsRes && signalsRes.__unauthorized) {
      state.signals = null;
    } else if (signalsRes && signalsRes.__error) {
      state.signals = null; anyError = true;
    } else {
      state.signals = signalsRes || null;
    }

    state.lastUpdated = Date.now();
    renderSignals();
    renderHitl();
    renderRuns();
    renderConversations();

    if (anySignedOut) setStatus("signed out", "home-pill-muted");
    else if (anyError) setStatus("partial", "home-pill-bad");
    else setStatus(`updated ${new Date().toLocaleTimeString()}`, "home-pill-ok");
  }

  refresh().catch(() => {});
  timer = setInterval(() => { refresh().catch(() => {}); }, pollMs);

  return {
    refresh,
    destroy() {
      state.destroyed = true;
      if (timer) clearInterval(timer);
      timer = null;
      try { root.replaceChildren(); } catch (_) { /* ignore */ }
    },
  };
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
