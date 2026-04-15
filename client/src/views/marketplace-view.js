/**
 * Plugin marketplace view for the SiskelBot SPA shell.
 *
 * Ported from the legacy `client/marketplace.html`. Two-pane layout:
 *   - Left:  plugin list with search + category filter.
 *   - Right: plugin detail with manifest summary and install controls.
 *
 * Backing endpoints (see routes/plugins.js):
 *   GET    /api/v1/marketplace                 — list available packs
 *   GET    /api/v1/marketplace/:packId         — pack detail (manifest + actions)
 *   GET    /api/v1/plugins/:id/state           — per-workspace install state
 *   POST   /api/v1/plugins/:id/install         — kicks off install job
 *   GET    /api/v1/plugins/jobs/:jobId         — poll install job
 *   POST   /api/v1/plugins/:id/enable          — enable installed plugin
 *   POST   /api/v1/plugins/:id/disable         — disable installed plugin
 *   DELETE /api/v1/plugins/:id                 — uninstall
 *
 * Pure helpers (filterPlugins, sortByName, summarizeManifest,
 * installButtonLabel, formatProgress, pluginRowState) are exported for
 * JSDOM-free unit tests.
 *
 * WIRING (do not modify client/src/app.js directly; this block documents the
 * one-line registration the shell is expected to perform on its side):
 *
 *   router.register("/marketplace", mountInto(() => import("./views/marketplace-view.js")));
 *
 * Scope: install-flow read+write only. The following are deferred:
 *   TODO: plugin authoring UI (editor, scaffolding)
 *   TODO: sandbox configuration (permissions, resource limits)
 *   TODO: marketplace publishing flow (submit, review, versioning)
 *   TODO: per-plugin execution UI (use /plugins/execute) — this view is for
 *         install lifecycle only.
 */

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_WORKSPACE = "default";
const CSS_HREF = new URL("./marketplace-view.css", import.meta.url).href;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Case-insensitive filter on a pack list. Matches name/description/author/
 * category substring; `category` (optional, empty-string means "all") must
 * match exactly when present.
 * Pure: returns a new array, does not mutate input.
 */
export function filterPlugins(packs, opts) {
  if (!Array.isArray(packs)) return [];
  const q = String(opts?.query || "").toLowerCase().trim();
  const cat = String(opts?.category || "").trim();
  return packs.filter((p) => {
    if (!p || typeof p !== "object") return false;
    if (cat && String(p.category || "") !== cat) return false;
    if (!q) return true;
    const hay = [
      p.id,
      p.name,
      p.description,
      p.author,
      p.category,
    ].map((x) => String(x || "").toLowerCase()).join(" ");
    return hay.includes(q);
  });
}

/**
 * Stable sort by name ascending (case-insensitive). Ties break by id.
 * Pure: returns a new array, does not mutate input.
 */
export function sortByName(packs) {
  if (!Array.isArray(packs)) return [];
  const indexed = packs.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => {
    const na = String(a.p?.name || "").toLowerCase();
    const nb = String(b.p?.name || "").toLowerCase();
    const cmp = na.localeCompare(nb);
    if (cmp !== 0) return cmp;
    const ia = String(a.p?.id || "");
    const ib = String(b.p?.id || "");
    const icmp = ia.localeCompare(ib);
    if (icmp !== 0) return icmp;
    return a.i - b.i;
  });
  return indexed.map((x) => x.p);
}

/**
 * Produce a compact summary of a pack manifest for the detail pane.
 * Tolerates missing fields. Returns a plain object suitable for rendering.
 */
export function summarizeManifest(pack) {
  const p = pack && typeof pack === "object" ? pack : {};
  const actions = Array.isArray(p.actions) ? p.actions : [];
  return {
    id: String(p.id || ""),
    name: String(p.name || p.id || "(untitled pack)"),
    version: p.version ? String(p.version) : "—",
    author: p.author ? String(p.author) : "Unknown",
    category: p.category ? String(p.category) : "uncategorized",
    description: p.description ? String(p.description) : "",
    actionCount: actions.length || Number(p.actionCount) || 0,
    actions: actions.map((a) => ({
      name: String(a?.name || ""),
      type: String(a?.type || ""),
    })),
  };
}

/**
 * Derive the install-button label for a pack given its state record.
 * States: "Install" | "Installed" | "Disabled" | "Installing…".
 */
export function installButtonLabel(state) {
  const s = state && typeof state === "object" ? state : {};
  if (s.installing) return "Installing…";
  if (!s.installed) return "Install";
  if (s.enabled === false) return "Disabled";
  return "Installed";
}

/**
 * Derive a row-state string from install state.
 * Returns "available" | "disabled" | "enabled".
 */
export function pluginRowState(state) {
  const s = state && typeof state === "object" ? state : {};
  if (!s.installed) return "available";
  if (s.enabled === false) return "disabled";
  return "enabled";
}

/**
 * Format a progress fraction in [0,1] as "42%". Clamps out-of-range.
 */
export function formatProgress(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n < 0) return "0%";
  if (n > 1) return "100%";
  return Math.round(n * 100) + "%";
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-marketplace-view="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-marketplace-view", "1");
  document.head.appendChild(link);
}

function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  if (children != null) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return el;
}

async function jsonFetch(fetchImpl, url, opts) {
  const res = await fetchImpl(url, { credentials: "include", ...opts });
  const ct = res.headers.get ? (res.headers.get("content-type") || "") : "";
  const body = ct.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.hint = body && body.hint;
    throw err;
  }
  return body;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} root
 * @param {{
 *   apiBase?: string,
 *   workspace?: string,
 *   fetchImpl?: typeof fetch,
 * }} [ctx]
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export default function mount(root, ctx = {}) {
  if (!root) throw new Error("mount root required");
  ensureStylesheet();

  const apiBase = (ctx.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    workspace: String(ctx.workspace || DEFAULT_WORKSPACE),
    packs: [],
    /** @type {Map<string, {installed:boolean, enabled:boolean, version?:string, lastError?:string, installing?:boolean, progress?:number}>} */
    installed: new Map(),
    query: "",
    category: "",
    selectedId: null,
    error: null,
    loading: false,
    destroyed: false,
  };

  // ── DOM scaffold ──────────────────────────────────────────────────────────
  const header = h("header", { class: "mk-header" }, [
    h("h1", { class: "mk-title", text: "Plugin marketplace" }),
    h("span", { class: "mk-subtitle", text: `workspace: ${state.workspace}` }),
    h("span", { class: "mk-pill mk-pill-muted", text: "loading…" }),
  ]);

  const searchInput = h("input", {
    class: "mk-search",
    type: "search",
    placeholder: "Search plugins…",
    "aria-label": "Search plugins",
  });
  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    renderList();
  });

  const categorySelect = h("select", {
    class: "mk-select",
    "aria-label": "Filter by category",
  }, [h("option", { value: "" }, "All categories")]);
  categorySelect.addEventListener("change", () => {
    state.category = categorySelect.value;
    renderList();
  });

  const refreshBtn = h("button", { class: "mk-btn", type: "button" }, "Refresh");
  refreshBtn.addEventListener("click", () => { refresh().catch(() => {}); });

  const toolbar = h("div", { class: "mk-toolbar" }, [
    searchInput,
    categorySelect,
    h("span", { class: "mk-spacer" }),
    refreshBtn,
  ]);

  const listEl = h("ul", { class: "mk-list", role: "listbox", "aria-label": "Plugin packs" });
  const emptyEl = h("div", { class: "mk-empty", hidden: "hidden", text: "No plugins match." });
  const errorBar = h("div", { class: "mk-error", role: "alert", hidden: "hidden" });

  const listPane = h("aside", { class: "mk-list-pane" }, [
    toolbar,
    errorBar,
    listEl,
    emptyEl,
  ]);

  const detailEl = h("section", { class: "mk-detail" });
  detailEl.appendChild(h("div", { class: "mk-detail-empty", text: "Select a plugin to see details." }));

  const wrap = h("section", { class: "mk-view" }, [
    header,
    h("div", { class: "mk-panes" }, [listPane, detailEl]),
  ]);

  root.replaceChildren(wrap);

  // ── Category select rebuild ───────────────────────────────────────────────
  function populateCategories() {
    const current = state.category;
    const cats = [...new Set(state.packs.map((p) => p.category).filter(Boolean))].sort();
    while (categorySelect.options.length > 1) categorySelect.remove(1);
    for (const c of cats) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
      categorySelect.appendChild(opt);
    }
    // Preserve selection if still valid.
    if (current && cats.includes(current)) categorySelect.value = current;
    else { categorySelect.value = ""; state.category = ""; }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function setStatusPill(text, cls) {
    const pill = header.querySelector(".mk-pill");
    if (!pill) return;
    pill.textContent = text;
    pill.className = "mk-pill " + cls;
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
    const filtered = sortByName(filterPlugins(state.packs, {
      query: state.query,
      category: state.category,
    }));
    listEl.replaceChildren();

    if (filtered.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = state.packs.length === 0
        ? "No plugins available."
        : "No plugins match the current filters.";
      return;
    }
    emptyEl.hidden = true;

    for (const pack of filtered) {
      const st = state.installed.get(pack.id) || { installed: false };
      const phase = pluginRowState(st);
      const item = h("li", {
        class: "mk-list-item" + (state.selectedId === pack.id ? " mk-list-item-active" : ""),
        role: "option",
        tabindex: "0",
        "aria-selected": state.selectedId === pack.id ? "true" : "false",
        dataset: { id: pack.id },
      }, [
        h("div", { class: "mk-list-row" }, [
          h("span", { class: "mk-list-name", text: pack.name || pack.id }),
          h("span", { class: "mk-list-version", text: "v" + (pack.version || "?") }),
        ]),
        h("div", { class: "mk-list-desc", text: pack.description || "" }),
        h("div", { class: "mk-list-meta" }, [
          h("span", { class: "mk-badge", text: pack.category || "uncategorized" }),
          h("span", { class: "mk-list-author", text: `by ${pack.author || "unknown"}` }),
          phase !== "available"
            ? h("span", { class: "mk-badge mk-badge-installed", text: phase === "enabled" ? "Installed" : "Disabled" })
            : null,
        ]),
      ]);
      item.addEventListener("click", () => selectPack(pack.id));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectPack(pack.id);
        }
      });
      listEl.appendChild(item);
    }
  }

  function renderDetail() {
    detailEl.replaceChildren();
    if (!state.selectedId) {
      detailEl.appendChild(h("div", { class: "mk-detail-empty", text: "Select a plugin to see details." }));
      return;
    }
    const pack = state.packs.find((p) => p.id === state.selectedId);
    if (!pack) {
      detailEl.appendChild(h("div", { class: "mk-detail-empty", text: "Plugin not found." }));
      return;
    }
    const manifest = summarizeManifest(pack);
    const st = state.installed.get(pack.id) || { installed: false };

    const actionsList = h("ul", { class: "mk-actions-list" });
    if (manifest.actions.length === 0) {
      actionsList.appendChild(h("li", { class: "mk-actions-empty", text: "No actions declared." }));
    } else {
      for (const a of manifest.actions) {
        actionsList.appendChild(h("li", null, `${a.name} (${a.type})`));
      }
    }

    const installBtn = h("button", {
      class: "mk-btn mk-btn-primary",
      type: "button",
      disabled: (st.installed || st.installing) ? "disabled" : null,
    }, installButtonLabel(st));
    if (!st.installed && !st.installing) {
      installBtn.addEventListener("click", () => handleInstall(pack.id).catch(() => {}));
    }

    const toggleBtn = st.installed
      ? h("button", {
          class: "mk-btn " + (st.enabled === false ? "mk-btn-enable" : "mk-btn-disable"),
          type: "button",
        }, st.enabled === false ? "Enable" : "Disable")
      : null;
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const want = st.enabled === false;
        handleToggle(pack.id, want).catch(() => {});
      });
    }

    const uninstallBtn = st.installed
      ? h("button", { class: "mk-btn mk-btn-danger", type: "button" }, "Uninstall")
      : null;
    if (uninstallBtn) {
      uninstallBtn.addEventListener("click", () => handleUninstall(pack.id).catch(() => {}));
    }

    const progressWrap = h("div", {
      class: "mk-progress",
      hidden: st.installing ? null : "hidden",
    }, [h("div", { class: "mk-progress-fill" })]);
    const fill = progressWrap.querySelector(".mk-progress-fill");
    if (fill) fill.style.width = formatProgress(st.progress || 0);

    const rowStatus = h("div", {
      class: "mk-row-status" + (st.lastError ? " mk-row-status-error" : ""),
      role: "status",
      "aria-live": "polite",
      text: st.lastError ? `Last error: ${st.lastError}` : "",
    });

    detailEl.appendChild(h("div", { class: "mk-detail-head" }, [
      h("h2", { class: "mk-detail-name", text: manifest.name }),
      h("span", { class: "mk-detail-version", text: "v" + manifest.version }),
    ]));
    detailEl.appendChild(h("div", { class: "mk-detail-meta" }, [
      h("span", { class: "mk-badge", text: manifest.category }),
      h("span", { class: "mk-detail-author", text: "by " + manifest.author }),
      h("span", { class: "mk-detail-count", text: `${manifest.actionCount} action${manifest.actionCount === 1 ? "" : "s"}` }),
    ]));
    detailEl.appendChild(h("p", { class: "mk-detail-desc", text: manifest.description || "(no description)" }));
    detailEl.appendChild(h("div", { class: "mk-detail-actions" }, [
      installBtn,
      toggleBtn,
      uninstallBtn,
    ]));
    detailEl.appendChild(progressWrap);
    detailEl.appendChild(rowStatus);
    detailEl.appendChild(h("h3", { class: "mk-detail-sub", text: "Manifest actions" }));
    detailEl.appendChild(actionsList);
  }

  function selectPack(id) {
    state.selectedId = id;
    renderList();
    renderDetail();
    // Fetch the richer manifest for the pane (the list item only has summary).
    fetchPackDetail(id).catch(() => {});
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function fetchPacks() {
    const data = await jsonFetch(fetchImpl, `${apiBase}/marketplace`);
    return Array.isArray(data?.packs) ? data.packs : [];
  }

  async function fetchPackDetail(id) {
    try {
      const data = await jsonFetch(fetchImpl, `${apiBase}/marketplace/${encodeURIComponent(id)}`);
      if (!data || state.destroyed) return;
      // Merge back into the in-memory pack list so summarizeManifest has full
      // actions data on next render.
      const idx = state.packs.findIndex((p) => p.id === id);
      if (idx !== -1) {
        state.packs[idx] = { ...state.packs[idx], ...data };
        if (state.selectedId === id) renderDetail();
      }
    } catch (_) { /* non-fatal */ }
  }

  async function fetchInstalledState(packIds) {
    const out = new Map();
    await Promise.all(packIds.map(async (id) => {
      try {
        const data = await jsonFetch(
          fetchImpl,
          `${apiBase}/plugins/${encodeURIComponent(id)}/state?workspaceId=${encodeURIComponent(state.workspace)}`,
        );
        if (!data) return;
        out.set(id, {
          installed: !!data.installed,
          enabled: data.enabled !== false,
          version: data.version || null,
          lastError: data.lastError || null,
        });
      } catch (_) { /* per-plugin ignore */ }
    }));
    return out;
  }

  async function refresh() {
    if (state.destroyed) return;
    if (!fetchImpl) {
      setError(new Error("fetch not available"));
      setStatusPill("offline", "mk-pill-bad");
      return;
    }
    state.loading = true;
    setStatusPill("loading…", "mk-pill-muted");
    try {
      const packs = await fetchPacks();
      state.packs = packs;
      state.installed = await fetchInstalledState(packs.map((p) => p.id));
      populateCategories();
      setError(null);
      setStatusPill(`${packs.length} pack${packs.length === 1 ? "" : "s"}`, "mk-pill-ok");
      renderList();
      renderDetail();
    } catch (err) {
      setStatusPill("error", "mk-pill-bad");
      if (err.status === 401 || err.status === 403) {
        setStatusPill("signed out", "mk-pill-muted");
        state.packs = [];
        state.installed = new Map();
        renderList();
      } else {
        setError(err);
      }
    } finally {
      state.loading = false;
    }
  }

  async function startInstall(packId) {
    const body = await jsonFetch(fetchImpl, `${apiBase}/plugins/${encodeURIComponent(packId)}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ workspaceId: state.workspace }),
    });
    return body || {};
  }

  async function pollJob(jobId) {
    return jsonFetch(fetchImpl, `${apiBase}/plugins/jobs/${encodeURIComponent(jobId)}`);
  }

  async function waitForJob(jobId, onProgress) {
    for (let i = 0; i < 200; i++) {
      if (state.destroyed) return null;
      const job = await pollJob(jobId);
      if (onProgress) onProgress(job);
      if (job?.status === "done") return job;
      if (job?.status === "error") {
        const err = new Error(job.error || "Install failed");
        err.hint = job.hint;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("Install timed out");
  }

  async function handleInstall(packId) {
    const prev = state.installed.get(packId) || { installed: false };
    state.installed.set(packId, { ...prev, installing: true, progress: 0, lastError: null });
    renderDetail();
    try {
      const { jobId, alreadyInstalled } = await startInstall(packId);
      if (!alreadyInstalled && jobId) {
        await waitForJob(jobId, (job) => {
          const cur = state.installed.get(packId) || {};
          state.installed.set(packId, { ...cur, progress: Number(job?.progress) || 0 });
          renderDetail();
        });
      }
      // Reload install state for this plugin.
      await reloadPluginState(packId);
    } catch (err) {
      const cur = state.installed.get(packId) || {};
      state.installed.set(packId, { ...cur, installing: false, lastError: err.message });
      renderList();
      renderDetail();
      throw err;
    }
  }

  async function handleToggle(packId, wantEnabled) {
    const endpoint = wantEnabled ? "enable" : "disable";
    try {
      await jsonFetch(fetchImpl, `${apiBase}/plugins/${encodeURIComponent(packId)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ workspaceId: state.workspace }),
      });
      await reloadPluginState(packId);
    } catch (err) {
      const cur = state.installed.get(packId) || {};
      state.installed.set(packId, { ...cur, lastError: err.message });
      renderList();
      renderDetail();
      throw err;
    }
  }

  async function handleUninstall(packId) {
    if (typeof confirm === "function" && !confirm(`Uninstall ${packId}?`)) return;
    try {
      await jsonFetch(
        fetchImpl,
        `${apiBase}/plugins/${encodeURIComponent(packId)}?workspaceId=${encodeURIComponent(state.workspace)}`,
        { method: "DELETE" },
      );
      await reloadPluginState(packId);
    } catch (err) {
      const cur = state.installed.get(packId) || {};
      state.installed.set(packId, { ...cur, lastError: err.message });
      renderList();
      renderDetail();
      throw err;
    }
  }

  async function reloadPluginState(packId) {
    try {
      const data = await jsonFetch(
        fetchImpl,
        `${apiBase}/plugins/${encodeURIComponent(packId)}/state?workspaceId=${encodeURIComponent(state.workspace)}`,
      );
      state.installed.set(packId, {
        installed: !!data?.installed,
        enabled: data?.enabled !== false,
        version: data?.version || null,
        lastError: data?.lastError || null,
        installing: false,
        progress: 1,
      });
    } catch (_) {
      const cur = state.installed.get(packId) || {};
      state.installed.set(packId, { ...cur, installing: false });
    }
    renderList();
    renderDetail();
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
