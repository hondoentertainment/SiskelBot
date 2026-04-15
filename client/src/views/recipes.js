/**
 * Recipes view for the SiskelBot SPA shell.
 *
 * Two-pane layout:
 *   - Left pane:  list of recipes (name + short description + step count).
 *   - Right pane: detail of the selected recipe — steps as a vertical
 *                 list with action types; a "Run" button at the bottom
 *                 that POSTs to the run endpoint and shows the result
 *                 (success / error / output summary) inline.
 *
 * Backend endpoints (v1):
 *   GET  /api/v1/recipes?workspace=...          -> { _version, items: Recipe[] }
 *   GET  /api/v1/recipes/:id?workspace=...      -> Recipe
 *   POST /api/v1/schedules/run-now/:recipeId    -> { ok: true } | 4xx { error, code }
 *
 * Where Recipe = { id, name, description, steps: Step[], createdAt }.
 * Step is an arbitrary object; commonly has { action, payload? } but we
 * treat it opaquely and format whatever shape we find.
 *
 * Pure helpers (sortRecipesByName, formatSteps, summarizeRun) are
 * exported for tests.
 *
 * TODO: edit/create UI is intentionally out of scope for this change
 *       (run-only, read path). Follow-up PR should add create/update
 *       forms similar to the Knowledge docs tab.
 *
 * WIRING — in client/src/app.js, replace the placeholder line:
 *
 *   router.register("/recipes", placeholderView("Recipes", "Saved recipes and automation templates."));
 *
 * with:
 *
 *   router.register("/recipes", mountInto(() => import("./views/recipes.js")));
 */

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_WORKSPACE = "default";
const CSS_HREF = new URL("./recipes.css", import.meta.url).href;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Stable sort by recipe name (case-insensitive). Returns a new array;
 * input is not mutated. Non-array input yields [].
 */
export function sortRecipesByName(list) {
  if (!Array.isArray(list)) return [];
  const indexed = list.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const na = String(a.r?.name || "").toLowerCase();
    const nb = String(b.r?.name || "").toLowerCase();
    const cmp = na.localeCompare(nb);
    if (cmp !== 0) return cmp;
    return a.i - b.i; // stable tie-break on original index
  });
  return indexed.map((x) => x.r);
}

/**
 * Format a recipe's steps as an array of display rows:
 *   { index, action, summary }
 * where:
 *   - action  is a string (step.action or step.type, or "step" as fallback)
 *   - summary is a short one-line description derived from step fields
 *             (payload preview / name / command / nested action)
 *
 * Exposed for tests. Pure — no DOM, no fetch.
 */
export function formatSteps(recipe) {
  const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
  return steps.map((s, i) => {
    const action = pickString(s, ["action", "type", "kind"]) || "step";
    const summary = stepSummary(s);
    return { index: i + 1, action, summary };
  });
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function stepSummary(step) {
  if (step == null) return "";
  if (typeof step === "string") return truncate(step, 120);
  if (typeof step !== "object") return String(step);
  // Prefer human-readable fields.
  const direct =
    pickString(step, ["summary", "description", "name", "title", "command", "cmd"]);
  if (direct) return truncate(direct, 120);
  const payload = step.payload ?? step.params ?? step.args;
  if (payload != null) {
    if (typeof payload === "string") return truncate(payload, 120);
    if (typeof payload === "object") {
      const inner = pickString(payload, ["name", "command", "cmd", "url", "path", "recipe"]);
      if (inner) return truncate(inner, 120);
      try { return truncate(JSON.stringify(payload), 120); } catch (_) { /* ignore */ }
    }
  }
  // Nested sub-action (e.g. { action: "run_recipe", recipe: "foo" }).
  const nested = pickString(step, ["recipe", "url", "path", "to"]);
  if (nested) return truncate(nested, 120);
  return "";
}

function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Normalise a recipe run HTTP result into a { ok, title, detail } shape
 * for inline rendering.
 *
 * Accepts:
 *   { ok: true }                            → success, no output
 *   { ok: true, stdout, stderr }            → success with output
 *   { ok: false, error, stderr, stdout }    → failed run (legacy shape)
 *   { error: { code, message }, code }      → structured apiError shape
 *   { error: "text", code: "RUN_FAILED" }   → recipes-route error shape
 *   Error instance                          → thrown network / fetch error
 *
 * Exposed for tests. Pure.
 */
export function summarizeRun(result) {
  if (result instanceof Error) {
    return { ok: false, title: "Request failed", detail: result.message || String(result) };
  }
  if (result == null) {
    return { ok: false, title: "No response", detail: "" };
  }
  // Structured v2-style error: { error: { code, message }, ... }
  if (result.error && typeof result.error === "object") {
    const code = result.error.code || result.code || "ERROR";
    const msg = result.error.message || result.error.hint || "Run failed";
    return { ok: false, title: `Failed: ${code}`, detail: String(msg) };
  }
  // Legacy error: { ok: false, error: "text" } or { error: "text" }
  if (result.ok === false || typeof result.error === "string") {
    const code = typeof result.code === "string" ? result.code : "RUN_FAILED";
    const msg = result.error || result.message || "Run failed";
    const extra = outputPreview(result);
    const detail = extra ? `${msg}\n\n${extra}` : String(msg);
    return { ok: false, title: `Failed: ${code}`, detail };
  }
  // Success.
  if (result.ok === true || result.ok === undefined) {
    const extra = outputPreview(result);
    return { ok: true, title: "Run complete", detail: extra || "Recipe executed successfully." };
  }
  return { ok: false, title: "Unknown response", detail: safeStringify(result) };
}

function outputPreview(result) {
  const parts = [];
  if (typeof result?.stdout === "string" && result.stdout.trim()) {
    parts.push("stdout:\n" + truncate(result.stdout.trim(), 600));
  }
  if (typeof result?.stderr === "string" && result.stderr.trim()) {
    parts.push("stderr:\n" + truncate(result.stderr.trim(), 600));
  }
  return parts.join("\n\n");
}

function safeStringify(v) {
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-recipes-view="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-recipes-view", "1");
  document.head.appendChild(link);
}

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function jsonFetch(fetchImpl, url, opts) {
  const res = await fetchImpl(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(opts?.headers || {}) },
    ...opts,
  });
  let body = null;
  const ct = res.headers?.get?.("content-type") || "";
  if (res.status !== 204 && ct.includes("application/json")) {
    try { body = await res.json(); } catch (_) { body = null; }
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── Mount ────────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} el
 * @param {{ apiBase?: string, workspace?: string, fetchImpl?: typeof fetch }} [ctx]
 */
export default function mount(el, ctx = {}) {
  if (!el) throw new Error("mount root required");
  const apiBase = ((ctx && ctx.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, "");
  const workspace = (ctx && ctx.workspace) || DEFAULT_WORKSPACE;
  const fetchImpl = (ctx && ctx.fetchImpl) || (typeof fetch !== "undefined" ? fetch : null);

  ensureStylesheet();

  const state = {
    recipes: [],
    selectedId: null,
    loading: false,
    error: null,
    runStatus: null, // { ok, title, detail } | null
    running: false,
    destroyed: false,
  };

  // ── Scaffold ─────────────────────────────────────────────────────────────
  const title = h("h1", { class: "rc-title", text: "Recipes" });
  const subtitle = h("span", { class: "rc-subtitle", text: `workspace: ${workspace}` });
  const statusPill = h("span", { class: "rc-pill rc-pill-loading", text: "loading…" });
  const header = h("header", { class: "rc-header" }, title, subtitle, statusPill);

  const refreshBtn = h(
    "button",
    { class: "rc-btn", type: "button", onclick: () => { reload().catch(() => {}); } },
    "Refresh"
  );
  const countSpan = h("span", { class: "rc-count", text: "—" });
  const leftToolbar = h("div", { class: "rc-left-toolbar" }, countSpan, refreshBtn);

  const listEl = h("ul", { class: "rc-list", role: "listbox", "aria-label": "Recipes" });
  const leftPane = h("aside", { class: "rc-left" }, leftToolbar, listEl);

  const rightPane = h("section", { class: "rc-right", "aria-live": "polite" });

  const errorBar = h("div", { class: "rc-error", role: "alert", hidden: "hidden" });

  const wrap = h(
    "section",
    { class: "rc-view", "aria-labelledby": "rc-view-title" },
    header,
    errorBar,
    h("div", { class: "rc-panes" }, leftPane, rightPane)
  );
  title.id = "rc-view-title";

  el.innerHTML = "";
  el.appendChild(wrap);
  renderRight();

  // ── Rendering ────────────────────────────────────────────────────────────
  function setPill(text, cls) {
    statusPill.textContent = text;
    statusPill.className = "rc-pill " + cls;
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
  }

  function renderList() {
    const sorted = sortRecipesByName(state.recipes);
    listEl.innerHTML = "";
    countSpan.textContent = `${sorted.length} recipe${sorted.length === 1 ? "" : "s"}`;

    if (sorted.length === 0) {
      const empty = h("li", { class: "rc-empty" },
        state.error
          ? "No recipes available."
          : "No recipes in this workspace yet."
      );
      listEl.appendChild(empty);
      return;
    }

    for (const r of sorted) {
      const stepCount = Array.isArray(r.steps) ? r.steps.length : 0;
      const desc = r.description ? truncate(String(r.description), 100) : "No description";
      const isActive = r.id === state.selectedId;
      const item = h("li", {
        class: "rc-item" + (isActive ? " rc-item-active" : ""),
        role: "option",
        "aria-selected": isActive ? "true" : "false",
        tabindex: "0",
        onclick: () => selectRecipe(r.id),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectRecipe(r.id);
          }
        },
      },
        h("div", { class: "rc-item-head" },
          h("span", { class: "rc-item-name", text: r.name || "(unnamed)" }),
          h("span", { class: "rc-item-steps", text: `${stepCount} step${stepCount === 1 ? "" : "s"}` })
        ),
        h("div", { class: "rc-item-desc", text: desc })
      );
      listEl.appendChild(item);
    }
  }

  function renderRight() {
    rightPane.innerHTML = "";
    const selected = state.recipes.find((r) => r.id === state.selectedId);
    if (!selected) {
      rightPane.appendChild(
        h("div", { class: "rc-placeholder" },
          h("p", { text: "Select a recipe on the left to view its steps." })
        )
      );
      return;
    }

    const rows = formatSteps(selected);
    const detailHead = h("div", { class: "rc-detail-head" },
      h("h2", { class: "rc-detail-title", text: selected.name || "(unnamed)" }),
      h("span", { class: "rc-detail-id", text: selected.id })
    );
    const descPara = selected.description
      ? h("p", { class: "rc-detail-desc", text: selected.description })
      : null;

    const stepsList = h("ol", { class: "rc-steps" });
    if (rows.length === 0) {
      stepsList.appendChild(h("li", { class: "rc-step rc-step-empty", text: "No steps defined." }));
    } else {
      for (const row of rows) {
        stepsList.appendChild(
          h("li", { class: "rc-step" },
            h("span", { class: "rc-step-index", text: String(row.index) }),
            h("span", { class: "rc-step-action", text: row.action }),
            row.summary
              ? h("span", { class: "rc-step-summary", text: row.summary })
              : null
          )
        );
      }
    }

    const runBtn = h(
      "button",
      {
        class: "rc-btn rc-btn-primary",
        type: "button",
        onclick: () => { runSelected().catch(() => {}); },
      },
      state.running ? "Running…" : "Run"
    );
    if (state.running) runBtn.setAttribute("disabled", "disabled");
    const runBar = h("div", { class: "rc-run-bar" }, runBtn);

    let runResultEl = null;
    if (state.runStatus) {
      const cls = state.runStatus.ok ? "rc-run-result rc-run-ok" : "rc-run-result rc-run-bad";
      runResultEl = h("div", { class: cls, role: "status" },
        h("div", { class: "rc-run-result-title", text: state.runStatus.title }),
        state.runStatus.detail
          ? h("pre", { class: "rc-run-result-detail", text: state.runStatus.detail })
          : null
      );
    }

    rightPane.appendChild(detailHead);
    if (descPara) rightPane.appendChild(descPara);
    rightPane.appendChild(stepsList);
    rightPane.appendChild(runBar);
    if (runResultEl) rightPane.appendChild(runResultEl);
  }

  function selectRecipe(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    state.runStatus = null; // clear prior run result on switch
    renderList();
    renderRight();
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  async function reload() {
    if (state.destroyed) return;
    if (!fetchImpl) {
      setError(new Error("fetch not available"));
      setPill("offline", "rc-pill-bad");
      renderList();
      return;
    }
    state.loading = true;
    setPill("loading…", "rc-pill-loading");
    try {
      const url = `${apiBase}/recipes?workspace=${encodeURIComponent(workspace)}`;
      const body = await jsonFetch(fetchImpl, url);
      const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
      state.recipes = items;
      // Preserve selection if still present; otherwise clear.
      if (state.selectedId && !items.some((r) => r.id === state.selectedId)) {
        state.selectedId = null;
        state.runStatus = null;
      }
      setError(null);
      setPill(`updated ${new Date().toLocaleTimeString()}`, "rc-pill-ok");
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        state.recipes = [];
        setPill("signed out", "rc-pill-muted");
      } else {
        setError(err);
        setPill("error", "rc-pill-bad");
      }
    } finally {
      state.loading = false;
      renderList();
      renderRight();
    }
  }

  async function runSelected() {
    const selected = state.recipes.find((r) => r.id === state.selectedId);
    if (!selected || state.running) return;
    if (!fetchImpl) {
      state.runStatus = summarizeRun(new Error("fetch not available"));
      renderRight();
      return;
    }
    state.running = true;
    state.runStatus = null;
    renderRight();
    try {
      const url = `${apiBase}/schedules/run-now/${encodeURIComponent(selected.id)}`;
      const body = await jsonFetch(fetchImpl, url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace }),
      });
      state.runStatus = summarizeRun(body ?? { ok: true });
    } catch (err) {
      // jsonFetch throws with err.body on non-2xx; prefer body so we get
      // the structured error envelope from the server.
      state.runStatus = summarizeRun(err.body || err);
    } finally {
      state.running = false;
      renderRight();
    }
  }

  // Kick off initial load.
  reload().catch(() => {});

  return {
    refresh: reload,
    destroy() {
      state.destroyed = true;
      try { el.innerHTML = ""; } catch (_) { /* ignore */ }
    },
  };
}
