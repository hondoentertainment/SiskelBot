/**
 * Command palette (Cmd/Ctrl+K) for the SiskelBot SPA shell.
 *
 * Exports:
 *   - filter(actions, query): pure fuzzy-match filter used by tests
 *   - score(title, query): pure subsequence scoring helper
 *   - debounce(fn, ms): trailing-edge debounce with cancel()
 *   - classifyResultType(result): classify a search hit into a row icon kind
 *   - buildPaletteRows(actions, query, contentResults): pure row composer
 *   - Palette: stateful overlay controller
 *   - palette: default singleton instance
 *
 * ARIA: overlay is role="dialog", results list is role="listbox",
 * items are role="option" with aria-selected on the active one.
 */

/**
 * Score a candidate title against a query using subsequence matching.
 * Returns -1 if no match. Higher scores = better matches.
 * - Exact substring matches score highest.
 * - Prefix matches rank above mid-string matches.
 * - Tight (adjacent) character runs rank above spread-out matches.
 * @param {string} title
 * @param {string} query
 * @returns {number}
 */
export function score(title, query) {
  if (!query) return 0;
  const t = String(title || "").toLowerCase();
  const q = String(query).toLowerCase();
  if (!t) return -1;

  const idx = t.indexOf(q);
  if (idx !== -1) {
    // substring hit: big bonus, prefix even bigger
    return 1000 - idx + (idx === 0 ? 500 : 0);
  }

  // fuzzy subsequence
  let ti = 0;
  let qi = 0;
  let s = 0;
  let lastMatch = -2;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      s += 10;
      if (ti === lastMatch + 1) s += 15; // adjacency bonus
      if (ti === 0 || /\s|[-_/:.]/.test(t[ti - 1])) s += 8; // word-boundary bonus
      lastMatch = ti;
      qi++;
    }
    ti++;
  }
  if (qi < q.length) return -1;
  return s - t.length * 0.1; // slight penalty for longer titles
}

/**
 * Filter and rank a list of palette actions against a query.
 * Preserves registration order when query is empty. Stable ordering on ties.
 *
 * @param {Array<{id:string,title:string,hint?:string,run?:Function}>} actions
 * @param {string} query
 * @returns {Array<{id:string,title:string,hint?:string,run?:Function,_score:number}>}
 */
export function filter(actions, query) {
  const list = Array.isArray(actions) ? actions : [];
  if (!query) {
    return list.map((a, i) => ({ ...a, _score: -i }));
  }
  const results = [];
  list.forEach((a, i) => {
    const titleScore = score(a.title, query);
    const hintScore = a.hint ? score(a.hint, query) : -1;
    const best = Math.max(titleScore, hintScore === -1 ? -Infinity : hintScore * 0.6);
    if (best > -1) results.push({ ...a, _score: best, _idx: i });
  });
  results.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return a._idx - b._idx;
  });
  return results.map(({ _idx, ...rest }) => rest);
}

/**
 * Standard trailing-edge debounce. The returned function exposes a cancel()
 * method that prevents any pending invocation from firing.
 *
 * @template {(...args:any[])=>any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & {cancel: () => void}}
 */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/**
 * Classify a /api/v1/search result into one of the known palette row kinds.
 * Inspects `result.type` first, then falls back to URL-based heuristics.
 *
 * @param {{type?:string,url?:string}} result
 * @returns {"chat"|"doc"|"recipe"|"run"|"other"}
 */
export function classifyResultType(result) {
  if (!result || typeof result !== "object") return "other";
  const raw = String(result.type || "").toLowerCase();
  if (raw) {
    if (raw === "conversation" || raw === "conversations" || raw === "chat" || raw === "message") return "chat";
    if (raw === "knowledge" || raw === "doc" || raw === "document") return "doc";
    if (raw === "recipe" || raw === "recipes") return "recipe";
    if (raw === "run" || raw === "runs" || raw === "agent-run" || raw === "agent_run") return "run";
  }
  const url = String(result.url || "").toLowerCase();
  if (url) {
    if (url.includes("/conversations") || url.includes("/chat")) return "chat";
    if (url.includes("/knowledge") || url.includes("/docs") || url.includes("/documents")) return "doc";
    if (url.includes("/recipes")) return "recipe";
    if (url.includes("/runs") || url.includes("/agent-sessions")) return "run";
  }
  return "other";
}

const TYPE_ICONS = {
  chat: "\u{1F4AC}",
  doc: "\u{1F4C4}",
  recipe: "\u{1F4D8}",
  run: "\u{26A1}",
  other: "\u{1F50D}",
};

/**
 * Compose the unified palette row list from filtered actions and content
 * results. Pure: no DOM, no I/O. Headers are interleaved as section dividers.
 *
 * @param {Array<object>} actions  filtered registered actions
 * @param {string} query            current user query (drives section visibility)
 * @param {Array<object>} contentResults  raw /api/v1/search results
 * @returns {Array<{kind:string,[k:string]:any}>}
 */
export function buildPaletteRows(actions, query, contentResults) {
  const rows = [];
  const acts = Array.isArray(actions) ? actions : [];
  const content = Array.isArray(contentResults) ? contentResults : [];
  const hasQuery = typeof query === "string" && query.trim().length > 0;

  if (acts.length > 0) {
    rows.push({ kind: "header", label: "Actions" });
    for (const a of acts) {
      rows.push({
        kind: "action",
        id: a.id,
        title: a.title,
        hint: a.hint || "",
        run: a.run,
      });
    }
  }

  if (hasQuery && content.length > 0) {
    rows.push({ kind: "header", label: "Content" });
    for (const r of content) {
      const type = classifyResultType(r);
      rows.push({
        kind: "content",
        type,
        icon: TYPE_ICONS[type] || TYPE_ICONS.other,
        title: r.title || r.name || r.id || "(untitled)",
        snippet: r.snippet || r.preview || r.excerpt || "",
        url: r.url || "",
        raw: r,
      });
    }
  }

  return rows;
}

function getShellWorkspace() {
  try {
    const ws = globalThis.SiskelbotShell && globalThis.SiskelbotShell.workspace;
    if (ws && typeof ws.id === "string" && ws.id) return ws.id;
  } catch (_e) { /* ignore */ }
  return "default";
}

function navigateTo(url) {
  if (!url) return;
  try {
    const r = globalThis.SiskelbotShell && globalThis.SiskelbotShell.router;
    if (r && typeof r.navigate === "function") {
      r.navigate(url);
      return;
    }
  } catch (_e) { /* fall through */ }
  try {
    if (typeof window !== "undefined" && window.location && typeof window.location.assign === "function") {
      window.location.assign(url);
    }
  } catch (_e) { /* ignore */ }
}

export class Palette {
  constructor() {
    this.actions = [];
    this.open = false;
    this.query = "";
    this.selected = 0;
    this.results = [];           // legacy: filtered actions only (kept for back-compat)
    this.rows = [];              // unified rows (actions + content)
    this.contentResults = [];    // raw /api/v1/search hits
    this.contentLoading = false;
    this.contentReqId = 0;
    this.root = null;
    this.input = null;
    this.list = null;
    this.spinner = null;
    this._onKey = this._onKey.bind(this);
    this._fetchContentDebounced = debounce(() => this._fetchContent(), 250);
  }

  register(action) {
    if (!action || !action.id || !action.title) return;
    this.actions = this.actions.filter(a => a.id !== action.id);
    this.actions.push(action);
  }

  unregister(id) {
    this.actions = this.actions.filter(a => a.id !== id);
  }

  mount(parent = document.body) {
    if (this.root) return;
    const overlay = document.createElement("div");
    overlay.className = "sb-palette-overlay";
    overlay.setAttribute("hidden", "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Command palette");
    overlay.innerHTML = `
      <div class="sb-palette" role="document">
        <input class="sb-palette-input" type="text" autocomplete="off"
               spellcheck="false" placeholder="Type a command or search..."
               aria-controls="sb-palette-list" aria-autocomplete="list" />
        <div class="sb-palette-spinner" aria-hidden="true" hidden></div>
        <ul class="sb-palette-list" id="sb-palette-list" role="listbox"
            aria-label="Commands"></ul>
        <div class="sb-palette-hint" aria-hidden="true">
          <kbd>Esc</kbd> close
          <kbd>↑↓</kbd> navigate
          <kbd>Enter</kbd> run
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    this.root = overlay;
    this.input = overlay.querySelector(".sb-palette-input");
    this.list = overlay.querySelector(".sb-palette-list");
    this.spinner = overlay.querySelector(".sb-palette-spinner");
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.selected = 0;
      this._render();
      const q = this.query.trim();
      if (q.length > 0) {
        this._fetchContentDebounced();
      } else {
        this._fetchContentDebounced.cancel();
        this.contentResults = [];
        this.contentLoading = false;
        this._render();
      }
    });
    parent.appendChild(overlay);
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    if (!this.root) this.mount();
    this.open = true;
    this.query = "";
    this.selected = 0;
    this.contentResults = [];
    this.contentLoading = false;
    this.input.value = "";
    this.root.removeAttribute("hidden");
    this._render();
    queueMicrotask(() => this.input && this.input.focus());
    document.addEventListener("keydown", this._onKey, true);
  }

  close() {
    if (!this.root) return;
    this.open = false;
    this.root.setAttribute("hidden", "");
    document.removeEventListener("keydown", this._onKey, true);
    if (this._fetchContentDebounced && this._fetchContentDebounced.cancel) {
      this._fetchContentDebounced.cancel();
    }
  }

  async _fetchContent() {
    const q = (this.query || "").trim();
    if (!q || !this.open) return;
    const reqId = ++this.contentReqId;
    this.contentLoading = true;
    this._renderSpinner();
    try {
      if (typeof fetch !== "function") {
        this.contentLoading = false;
        this._renderSpinner();
        return;
      }
      const ws = getShellWorkspace();
      const url = `/api/v1/search?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(ws)}&limit=8`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { "Accept": "application/json" },
      });
      if (reqId !== this.contentReqId) return; // stale
      if (!res || !res.ok) {
        // 401, 404, 5xx -> degrade silently
        this.contentResults = [];
        this.contentLoading = false;
        this._render();
        return;
      }
      const body = await res.json().catch(() => null);
      if (reqId !== this.contentReqId) return;
      const hits = (body && Array.isArray(body.results)) ? body.results : [];
      this.contentResults = hits;
      this.contentLoading = false;
      this._render();
    } catch (_e) {
      if (reqId !== this.contentReqId) return;
      this.contentResults = [];
      this.contentLoading = false;
      this._render();
    }
  }

  _renderSpinner() {
    if (!this.spinner) return;
    if (this.contentLoading) this.spinner.removeAttribute("hidden");
    else this.spinner.setAttribute("hidden", "");
  }

  _render() {
    if (!this.list) return;
    this.results = filter(this.actions, this.query);
    this.rows = buildPaletteRows(this.results, this.query, this.contentResults);

    // Selection should only land on selectable rows (skip headers).
    const selectableCount = this.rows.filter(r => r.kind !== "header").length;
    if (this.selected >= selectableCount) this.selected = Math.max(0, selectableCount - 1);

    this.list.innerHTML = "";
    this._renderSpinner();

    if (this.rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "sb-palette-empty";
      empty.setAttribute("role", "option");
      empty.setAttribute("aria-disabled", "true");
      empty.textContent = "No matches";
      this.list.appendChild(empty);
      return;
    }

    let selIdx = 0;
    this.rows.forEach((row) => {
      if (row.kind === "header") {
        const h = document.createElement("li");
        h.className = "sb-palette-header";
        h.setAttribute("role", "presentation");
        h.textContent = row.label;
        this.list.appendChild(h);
        return;
      }
      const i = selIdx++;
      const li = document.createElement("li");
      li.className = "sb-palette-item" + (row.kind === "content" ? " sb-palette-item--content" : "")
        + (i === this.selected ? " is-active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === this.selected ? "true" : "false");
      li.dataset.idx = String(i);
      if (row.kind === "action") {
        li.innerHTML = `<span class="sb-palette-title"></span><span class="sb-palette-hint-text"></span>`;
        li.querySelector(".sb-palette-title").textContent = row.title;
        if (row.hint) li.querySelector(".sb-palette-hint-text").textContent = row.hint;
      } else {
        li.innerHTML = `<span class="sb-palette-icon" aria-hidden="true"></span>`
          + `<span class="sb-palette-body">`
          + `<span class="sb-palette-title"></span>`
          + `<span class="sb-palette-snippet"></span>`
          + `</span>`
          + `<span class="sb-palette-kbd" aria-hidden="true"><kbd>↵</kbd> open</span>`;
        li.querySelector(".sb-palette-icon").textContent = row.icon;
        li.querySelector(".sb-palette-title").textContent = row.title;
        if (row.snippet) li.querySelector(".sb-palette-snippet").textContent = row.snippet;
      }
      li.addEventListener("mouseenter", () => { this.selected = i; this._updateSelection(); });
      li.addEventListener("click", () => this._runAt(i));
      this.list.appendChild(li);
    });
    this._updateSelection();
  }

  _selectableRows() {
    return this.rows.filter(r => r.kind !== "header");
  }

  _updateSelection() {
    if (!this.list) return;
    const items = this.list.querySelectorAll(".sb-palette-item");
    items.forEach((el, i) => {
      const active = i === this.selected;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
      if (active && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    });
    const sel = this._selectableRows();
    if (this.input && sel[this.selected]) {
      this.input.setAttribute("aria-activedescendant", `sb-palette-opt-${this.selected}`);
    }
  }

  _runAt(idx) {
    const sel = this._selectableRows();
    const r = sel[idx];
    if (!r) { this.close(); return; }
    if (r.kind === "action") {
      if (typeof r.run !== "function") { this.close(); return; }
      this.close();
      try { r.run(); } catch (e) { console.error("palette action error", e); }
      return;
    }
    if (r.kind === "content") {
      this.close();
      try { navigateTo(r.url); } catch (e) { console.error("palette navigate error", e); }
      return;
    }
    this.close();
  }

  _onKey(e) {
    if (!this.open) return;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    const sel = this._selectableRows();
    const max = Math.max(0, sel.length - 1);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = Math.min(max, this.selected + 1);
      this._updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = Math.max(0, this.selected - 1);
      this._updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this._runAt(this.selected);
    }
  }
}

export const palette = new Palette();
