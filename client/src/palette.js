/**
 * Command palette (Cmd/Ctrl+K) for the SiskelBot SPA shell.
 *
 * Exports:
 *   - filter(actions, query): pure fuzzy-match filter used by tests
 *   - score(title, query): pure subsequence scoring helper
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

export class Palette {
  constructor() {
    this.actions = [];
    this.open = false;
    this.query = "";
    this.selected = 0;
    this.results = [];
    this.root = null;
    this.input = null;
    this.list = null;
    this._onKey = this._onKey.bind(this);
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
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.selected = 0;
      this._render();
    });
    parent.appendChild(overlay);
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    if (!this.root) this.mount();
    this.open = true;
    this.query = "";
    this.selected = 0;
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
  }

  _render() {
    if (!this.list) return;
    this.results = filter(this.actions, this.query);
    if (this.selected >= this.results.length) this.selected = Math.max(0, this.results.length - 1);
    this.list.innerHTML = "";
    if (this.results.length === 0) {
      const empty = document.createElement("li");
      empty.className = "sb-palette-empty";
      empty.setAttribute("role", "option");
      empty.setAttribute("aria-disabled", "true");
      empty.textContent = "No matches";
      this.list.appendChild(empty);
      return;
    }
    this.results.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "sb-palette-item" + (i === this.selected ? " is-active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === this.selected ? "true" : "false");
      li.dataset.idx = String(i);
      li.innerHTML = `<span class="sb-palette-title"></span><span class="sb-palette-hint-text"></span>`;
      li.querySelector(".sb-palette-title").textContent = r.title;
      if (r.hint) li.querySelector(".sb-palette-hint-text").textContent = r.hint;
      li.addEventListener("mouseenter", () => { this.selected = i; this._updateSelection(); });
      li.addEventListener("click", () => this._runAt(i));
      this.list.appendChild(li);
    });
    this._updateSelection();
  }

  _updateSelection() {
    if (!this.list) return;
    const items = this.list.querySelectorAll(".sb-palette-item");
    items.forEach((el, i) => {
      const active = i === this.selected;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
      if (active) el.scrollIntoView({ block: "nearest" });
    });
    if (this.input && this.results[this.selected]) {
      this.input.setAttribute("aria-activedescendant", `sb-palette-opt-${this.selected}`);
    }
  }

  _runAt(idx) {
    const r = this.results[idx];
    if (!r || typeof r.run !== "function") { this.close(); return; }
    this.close();
    try { r.run(); } catch (e) { console.error("palette action error", e); }
  }

  _onKey(e) {
    if (!this.open) return;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = Math.min(this.results.length - 1, this.selected + 1);
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
