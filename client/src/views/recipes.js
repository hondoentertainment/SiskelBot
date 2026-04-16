/**
 * Recipes view — two-pane list + editor + runner for SiskelBot's SPA shell.
 *
 * Pure helpers (validateStepArgs, moveStep, isValidRecipeName) are exported
 * for tests.
 *
 * Endpoint adapters:
 *   - List:   GET    {apiBase}/recipes?workspace=<ws>
 *               accepts [], {items: []}, {data:{items:[]}}, {recipes:[]}
 *   - Create: POST   {apiBase}/recipes      body: {name, description, steps, workspace}
 *   - Update: PUT    {apiBase}/recipes/:id  body: {name, description, steps, workspace}
 *   - Delete: DELETE {apiBase}/recipes/:id?workspace=<ws>
 *   - Run:    POST   {apiBase}/recipes/:id/run   (spec'd path)
 *               falls back to POST {apiBase}/schedules/run-now/:id when 404.
 *
 * Server route uses `:id` (uuid) rather than `:name`; the view stores the
 * server-issued id on each row and uses it for URL params, while name is
 * editable and used purely as a human label.
 */

const DEFAULT_API_BASE = "/api/v1";
const CSS_HREF = new URL("./recipes.css", import.meta.url).href;
const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Parse and validate a free-text JSON args blob from the editor.
 * - Empty / whitespace → `{ ok: true, value: {} }`
 * - JSON.parse failure → `{ ok: false, error }`
 * - Non-plain-object (array, primitive, null) → `{ ok: false, error }`
 */
export function validateStepArgs(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return { ok: true, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Args must be a JSON object (e.g. {\"key\": \"value\"})" };
  }
  return { ok: true, value: parsed };
}

/**
 * Move a step within a steps array. Pure: returns a new array.
 * Clamps indices and is a no-op if from === to or array is too short.
 */
export function moveStep(steps, fromIdx, toIdx) {
  if (!Array.isArray(steps)) return [];
  const next = steps.slice();
  if (next.length < 2) return next;
  const from = clamp(fromIdx, 0, next.length - 1);
  const to = clamp(toIdx, 0, next.length - 1);
  if (from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? Math.floor(n) : 0;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Validate a recipe name. Lowercase letters/digits/dot/underscore/hyphen,
 * leading char must be alphanumeric, total length 1-64.
 */
export function isValidRecipeName(name) {
  if (typeof name !== "string") return false;
  return RECIPE_NAME_RE.test(name);
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
  if (document.querySelector('link[data-recipes-css="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.recipesCss = "1";
  document.head.appendChild(link);
}

function normalizeListResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && data.data && Array.isArray(data.data.items)) return data.data.items;
  if (data && Array.isArray(data.recipes)) return data.recipes;
  return [];
}

function fmtTimestamp(v) {
  if (!v) return "";
  const n = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(n)) return "";
  return new Date(n).toLocaleString();
}

async function safeJson(resp) {
  try { return await resp.json(); } catch (_) { return null; }
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} root
 * @param {{ workspace?: string, apiBase?: string, fetchImpl?: typeof fetch }} [ctx]
 */
export default function mount(root, ctx = {}) {
  if (!root) throw new Error("mount root required");
  const apiBase = (ctx.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const workspace = String(ctx.workspace || "default");

  ensureStylesheet();

  const state = {
    recipes: [],
    selectedId: null,   // server id of currently-loaded recipe ("" for new/unsaved)
    draft: null,        // {id?, name, description, steps:[{tool, argsText}]}
    error: null,
    output: null,       // run output JSON
    busy: false,
  };

  // ── Left pane ─────────────────────────────────────────────────────────────
  const listEl = el("ul", { class: "rcp-list", role: "listbox", "aria-label": "Recipes" });
  const newBtn = el("button", { class: "rcp-btn rcp-btn-primary", type: "button" }, "+ New recipe");
  newBtn.addEventListener("click", () => openDraft(null));
  const refreshBtn = el("button", { class: "rcp-btn", type: "button" }, "Refresh");
  refreshBtn.addEventListener("click", () => { void load(); });

  const leftHeader = el("header", { class: "rcp-side-header" }, [
    el("h2", { class: "rcp-side-title" }, "Recipes"),
    el("span", { class: "rcp-ws" }, `ws: ${workspace}`),
  ]);
  const leftToolbar = el("div", { class: "rcp-side-toolbar" }, [newBtn, refreshBtn]);
  const leftPane = el("aside", { class: "rcp-pane rcp-pane-list" }, [
    leftHeader,
    leftToolbar,
    listEl,
  ]);

  // ── Right pane: editor scaffold ───────────────────────────────────────────
  const errorBar = el("div", { class: "rcp-error", role: "alert", hidden: "hidden" });
  const detail = el("div", { class: "rcp-detail" });
  const outputPanel = el("pre", { class: "rcp-output", hidden: "hidden", "aria-live": "polite" });
  const rightPane = el("section", { class: "rcp-pane rcp-pane-detail" }, [errorBar, detail, outputPanel]);

  const wrap = el("section", { class: "rcp-view", "aria-label": "Recipes" }, [leftPane, rightPane]);
  root.replaceChildren(wrap);

  // ── State helpers ─────────────────────────────────────────────────────────
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

  function setOutput(value) {
    state.output = value;
    if (value == null) {
      outputPanel.hidden = true;
      outputPanel.textContent = "";
      return;
    }
    outputPanel.hidden = false;
    try { outputPanel.textContent = JSON.stringify(value, null, 2); }
    catch (_) { outputPanel.textContent = String(value); }
  }

  function recipeToDraft(r) {
    const steps = Array.isArray(r?.steps) ? r.steps : [];
    return {
      id: r?.id || null,
      name: r?.name || "",
      description: r?.description || "",
      steps: steps.map((s) => ({
        tool: typeof s?.tool === "string" ? s.tool : "",
        argsText: s?.args ? safeStringify(s.args) : "{}",
      })),
    };
  }

  function safeStringify(v) {
    try { return JSON.stringify(v, null, 2); } catch (_) { return "{}"; }
  }

  // ── Render: list ──────────────────────────────────────────────────────────
  function renderList() {
    listEl.replaceChildren();
    if (state.recipes.length === 0) {
      const empty = el("li", { class: "rcp-empty" }, [
        el("p", null, "No recipes yet."),
        (() => {
          const b = el("button", { class: "rcp-btn rcp-btn-primary", type: "button" }, "+ New recipe");
          b.addEventListener("click", () => openDraft(null));
          return b;
        })(),
      ]);
      listEl.appendChild(empty);
      return;
    }
    for (const r of state.recipes) {
      const id = r.id || r.name;
      const isActive = id === state.selectedId;
      const li = el("li", {
        class: "rcp-item" + (isActive ? " rcp-item-active" : ""),
        role: "option",
        "aria-selected": isActive ? "true" : "false",
        tabindex: "0",
        dataset: { id: String(id) },
      }, [
        el("div", { class: "rcp-item-name" }, r.name || "(unnamed)"),
        el("div", { class: "rcp-item-meta" }, [
          el("span", null, `${r.stepCount ?? (Array.isArray(r.steps) ? r.steps.length : 0)} steps`),
          el("span", { class: "rcp-item-ts" }, fmtTimestamp(r.updatedAt || r.createdAt)),
        ]),
        r.description ? el("div", { class: "rcp-item-desc" }, r.description) : null,
      ]);
      const onActivate = () => { void openExisting(r); };
      li.addEventListener("click", onActivate);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
      });
      listEl.appendChild(li);
    }
  }

  // ── Render: editor ────────────────────────────────────────────────────────
  function renderDetail() {
    detail.replaceChildren();
    if (!state.draft) {
      const placeholder = el("div", { class: "rcp-placeholder" }, [
        el("h3", null, "Select or create a recipe"),
        el("p", null, "Recipes are reusable sequences of agent tools you can run on demand."),
      ]);
      detail.appendChild(placeholder);
      return;
    }

    const d = state.draft;
    const nameInput = el("input", {
      class: "rcp-input", type: "text", placeholder: "recipe-name",
      "aria-label": "Recipe name", maxlength: "64", value: d.name,
    });
    nameInput.addEventListener("input", () => { d.name = nameInput.value; });

    const descInput = el("textarea", {
      class: "rcp-textarea rcp-desc",
      placeholder: "Optional description",
      "aria-label": "Description", rows: "2",
    });
    descInput.value = d.description;
    descInput.addEventListener("input", () => { d.description = descInput.value; });

    // Steps
    const stepsEl = el("ol", { class: "rcp-steps", "aria-label": "Steps" });
    d.steps.forEach((step, i) => stepsEl.appendChild(renderStep(step, i)));

    const addStepBtn = el("button", { class: "rcp-btn", type: "button" }, "+ Add step");
    addStepBtn.addEventListener("click", () => {
      d.steps.push({ tool: "", argsText: "{}" });
      renderDetail();
    });

    // Action buttons
    const saveBtn = el("button", { class: "rcp-btn rcp-btn-primary", type: "button" }, "Save");
    saveBtn.addEventListener("click", () => { void onSave(); });

    const runBtn = el("button", { class: "rcp-btn rcp-btn-run", type: "button" }, "Run");
    runBtn.disabled = !d.id;
    runBtn.title = d.id ? "Run this recipe" : "Save the recipe before running";
    runBtn.addEventListener("click", () => { void onRun(); });

    const deleteBtn = el("button", { class: "rcp-btn rcp-btn-danger", type: "button" }, "Delete");
    deleteBtn.disabled = !d.id;
    deleteBtn.addEventListener("click", () => { void onDelete(); });

    const actions = el("div", { class: "rcp-actions" }, [
      saveBtn,
      runBtn,
      el("span", { class: "rcp-actions-spacer" }),
      deleteBtn,
    ]);

    const form = el("div", { class: "rcp-form" }, [
      el("label", { class: "rcp-label" }, [el("span", null, "Name"), nameInput]),
      el("label", { class: "rcp-label" }, [el("span", null, "Description"), descInput]),
      el("div", { class: "rcp-steps-header" }, [
        el("h3", { class: "rcp-h3" }, "Steps"),
        addStepBtn,
      ]),
      stepsEl,
      actions,
    ]);
    detail.appendChild(form);
  }

  function renderStep(step, idx) {
    const li = el("li", { class: "rcp-step", dataset: { idx: String(idx) } });

    const toolInput = el("input", {
      class: "rcp-input rcp-step-tool", type: "text",
      placeholder: "tool name (e.g. search_context)",
      "aria-label": `Step ${idx + 1} tool`, value: step.tool,
    });
    toolInput.addEventListener("input", () => { step.tool = toolInput.value; });

    const argsArea = el("textarea", {
      class: "rcp-textarea rcp-step-args",
      placeholder: "{ }",
      "aria-label": `Step ${idx + 1} arguments (JSON)`,
      rows: "4",
      spellcheck: "false",
    });
    argsArea.value = step.argsText;
    argsArea.addEventListener("input", () => { step.argsText = argsArea.value; });

    const upBtn = el("button", { class: "rcp-btn rcp-btn-icon", type: "button", "aria-label": "Move up" }, "↑");
    upBtn.addEventListener("click", () => {
      state.draft.steps = moveStep(state.draft.steps, idx, idx - 1);
      renderDetail();
    });
    const downBtn = el("button", { class: "rcp-btn rcp-btn-icon", type: "button", "aria-label": "Move down" }, "↓");
    downBtn.addEventListener("click", () => {
      state.draft.steps = moveStep(state.draft.steps, idx, idx + 1);
      renderDetail();
    });
    const rmBtn = el("button", { class: "rcp-btn rcp-btn-icon rcp-btn-danger", type: "button", "aria-label": "Remove step" }, "×");
    rmBtn.addEventListener("click", () => {
      state.draft.steps.splice(idx, 1);
      renderDetail();
    });

    const stepHeader = el("div", { class: "rcp-step-header" }, [
      el("span", { class: "rcp-step-num" }, String(idx + 1)),
      toolInput,
      upBtn, downBtn, rmBtn,
    ]);
    li.appendChild(stepHeader);
    li.appendChild(el("label", { class: "rcp-step-args-label" }, [
      el("span", null, "args (JSON)"),
      argsArea,
    ]));
    return li;
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function openDraft(seed) {
    state.selectedId = "";
    state.draft = seed ? recipeToDraft(seed) : { id: null, name: "", description: "", steps: [] };
    setError(null);
    setOutput(null);
    renderList();
    renderDetail();
  }

  async function openExisting(row) {
    const id = row.id || row.name;
    state.selectedId = id;
    setError(null);
    setOutput(null);

    // Try to fetch the full recipe; fall back to the row payload if it fails.
    let full = row;
    if (fetchImpl && row?.id) {
      try {
        const resp = await fetchImpl(`${apiBase}/recipes/${encodeURIComponent(row.id)}?workspace=${encodeURIComponent(workspace)}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (resp.ok) {
          const body = await resp.json();
          if (body && typeof body === "object") full = body;
        }
      } catch (_) { /* keep row */ }
    }
    state.draft = recipeToDraft(full);
    renderList();
    renderDetail();
  }

  function buildSavePayload() {
    const d = state.draft;
    if (!isValidRecipeName(d.name.trim())) {
      throw new Error("Name must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
    }
    const steps = [];
    for (let i = 0; i < d.steps.length; i++) {
      const s = d.steps[i];
      const tool = (s.tool || "").trim();
      if (!tool) throw new Error(`Step ${i + 1}: tool name is required`);
      const v = validateStepArgs(s.argsText);
      if (!v.ok) throw new Error(`Step ${i + 1}: ${v.error}`);
      steps.push({ tool, args: v.value });
    }
    return {
      name: d.name.trim(),
      description: d.description.trim(),
      steps,
      workspace,
    };
  }

  async function onSave() {
    if (!fetchImpl) { setError(new Error("fetch not available")); return; }
    setError(null);
    let payload;
    try { payload = buildSavePayload(); } catch (e) { setError(e); return; }
    if (state.busy) return;
    state.busy = true;
    try {
      const isUpdate = !!state.draft.id;
      const url = isUpdate
        ? `${apiBase}/recipes/${encodeURIComponent(state.draft.id)}`
        : `${apiBase}/recipes`;
      const resp = await fetchImpl(url, {
        method: isUpdate ? "PUT" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || body?.error || `HTTP ${resp.status}`);
      }
      const saved = await resp.json();
      // Update local draft id from server response.
      if (saved && saved.id) state.draft.id = saved.id;
      state.selectedId = state.draft.id;
      await load();
      renderDetail();
    } catch (err) {
      setError(err);
    } finally {
      state.busy = false;
    }
  }

  async function onRun() {
    if (!fetchImpl) { setError(new Error("fetch not available")); return; }
    if (!state.draft?.id) { setError(new Error("Save the recipe before running")); return; }
    setError(null);
    setOutput({ status: "running…" });
    state.busy = true;
    try {
      const id = encodeURIComponent(state.draft.id);
      // Try the spec'd endpoint first; fall back to the schedules run-now path.
      let resp = await fetchImpl(`${apiBase}/recipes/${id}/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ workspace }),
      });
      if (resp.status === 404 || resp.status === 405) {
        resp = await fetchImpl(`${apiBase}/schedules/run-now/${id}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ workspace }),
        });
      }
      if (!resp.ok) {
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || body?.error || `HTTP ${resp.status}`);
      }
      const out = await safeJson(resp);
      setOutput(out ?? { status: "ok" });
    } catch (err) {
      setError(err);
      setOutput(null);
    } finally {
      state.busy = false;
    }
  }

  async function onDelete() {
    if (!fetchImpl) { setError(new Error("fetch not available")); return; }
    if (!state.draft?.id) return;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm(`Delete recipe "${state.draft.name}"? This cannot be undone.`)) return;
    }
    setError(null);
    state.busy = true;
    try {
      const url = `${apiBase}/recipes/${encodeURIComponent(state.draft.id)}?workspace=${encodeURIComponent(workspace)}`;
      const resp = await fetchImpl(url, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok && resp.status !== 204) {
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || body?.error || `HTTP ${resp.status}`);
      }
      state.draft = null;
      state.selectedId = null;
      setOutput(null);
      await load();
      renderDetail();
    } catch (err) {
      setError(err);
    } finally {
      state.busy = false;
    }
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function load() {
    if (!fetchImpl) { setError(new Error("fetch not available")); return; }
    try {
      const url = `${apiBase}/recipes?workspace=${encodeURIComponent(workspace)}`;
      const resp = await fetchImpl(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          state.recipes = [];
          renderList();
          return;
        }
        const body = await safeJson(resp);
        throw new Error(body?.error?.message || `HTTP ${resp.status}`);
      }
      const body = await resp.json();
      state.recipes = normalizeListResponse(body);
      renderList();
    } catch (err) {
      setError(err);
    }
  }

  // Initial render + fetch
  renderList();
  renderDetail();
  void load();

  return {
    refresh: load,
    destroy() {
      try { root.replaceChildren(); } catch (_) { /* ignore */ }
    },
  };
}
