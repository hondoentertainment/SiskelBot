/**
 * Top application header.
 * Contains: brand, workspace switcher placeholder, palette-launching search,
 * and an avatar slot for the current user.
 */
import { palette } from "../palette.js";

export function createHeader() {
  const el = document.createElement("header");
  el.className = "sb-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `
    <a class="skip-link" href="#sb-main">Skip to main</a>
    <div class="sb-brand">
      <span class="sb-brand-dot" aria-hidden="true"></span>
      <span class="sb-brand-name">SiskelBot</span>
    </div>
    <button class="sb-workspace-switcher" type="button"
            aria-haspopup="listbox" aria-expanded="false"
            data-action="open-workspace-switcher">
      <span class="sb-workspace-label">Default workspace</span>
      <span aria-hidden="true">▾</span>
    </button>
    <button class="sb-header-search" type="button"
            aria-label="Open command palette"
            data-action="open-palette">
      <span aria-hidden="true">⌕</span>
      <span class="sb-header-search-text">Search or run a command</span>
      <kbd class="sb-kbd">⌘K</kbd>
    </button>
    <div class="sb-header-right">
      <button class="sb-avatar" type="button" aria-label="Account menu"
              data-action="open-account">
        <span aria-hidden="true">SB</span>
      </button>
    </div>
  `;

  el.querySelector('[data-action="open-palette"]').addEventListener("click", () => palette.show());
  el.querySelector('[data-action="open-workspace-switcher"]').addEventListener("click", (e) => {
    // Placeholder: downstream agents will wire the real workspace switcher.
    const btn = e.currentTarget;
    btn.setAttribute("aria-expanded", btn.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });

  return {
    el,
    setWorkspaceLabel(label) {
      el.querySelector(".sb-workspace-label").textContent = label;
    },
    setAvatar(node) {
      const slot = el.querySelector(".sb-avatar");
      slot.innerHTML = "";
      slot.appendChild(node);
    }
  };
}
