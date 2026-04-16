/**
 * Top application header.
 * Contains: brand, real workspace switcher (<select>), palette-launching search,
 * and an avatar slot showing the signed-in user's display name (or a "Sign in"
 * link when unauthenticated).
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
    <label class="sb-workspace-switcher" aria-label="Active workspace">
      <span class="sb-workspace-switcher-label" hidden>Workspace</span>
      <select class="sb-workspace-select" data-action="switch-workspace" disabled>
        <option value="">No workspaces</option>
      </select>
    </label>
    <button class="sb-header-search" type="button"
            aria-label="Open command palette"
            data-action="open-palette">
      <span aria-hidden="true">⌕</span>
      <span class="sb-header-search-text">Search or run a command</span>
      <kbd class="sb-kbd">⌘K</kbd>
    </button>
    <div class="sb-header-right">
      <div class="sb-account" data-state="guest">
        <span class="sb-avatar" aria-hidden="true">
          <span class="sb-avatar-initials">G</span>
        </span>
        <a class="sb-account-action" href="/auth/github" data-action="sign-in">Sign in</a>
      </div>
    </div>
  `;

  el.querySelector('[data-action="open-palette"]').addEventListener("click", () => palette.show());

  const select = el.querySelector(".sb-workspace-select");
  let onChange = null;
  select.addEventListener("change", (e) => {
    if (typeof onChange === "function") onChange(e.target.value);
  });

  function setWorkspaces(list, activeId) {
    const items = Array.isArray(list) ? list : [];
    select.innerHTML = "";
    if (items.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No workspaces";
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const w of items) {
      const opt = document.createElement("option");
      opt.value = String(w.id);
      opt.textContent = w.name || w.id;
      if (activeId != null && String(w.id) === String(activeId)) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function setActiveWorkspace(id) {
    if (id == null) return;
    const idStr = String(id);
    for (const opt of select.options) {
      if (opt.value === idStr) { opt.selected = true; return; }
    }
  }

  function onWorkspaceChange(fn) { onChange = typeof fn === "function" ? fn : null; }

  function setUser(user) {
    const account = el.querySelector(".sb-account");
    account.innerHTML = "";
    const avatar = document.createElement("span");
    avatar.className = "sb-avatar";
    avatar.setAttribute("aria-hidden", "true");
    if (user && user.avatarUrl) {
      const img = document.createElement("img");
      img.src = user.avatarUrl;
      img.alt = "";
      img.className = "sb-avatar-img";
      avatar.appendChild(img);
    } else {
      const initials = document.createElement("span");
      initials.className = "sb-avatar-initials";
      initials.textContent = computeInitials(user);
      avatar.appendChild(initials);
    }
    account.appendChild(avatar);
    if (user) {
      account.setAttribute("data-state", "user");
      const name = document.createElement("span");
      name.className = "sb-account-name";
      name.textContent = user.displayName || user.email || user.userId || "User";
      account.appendChild(name);
    } else {
      account.setAttribute("data-state", "guest");
      const link = document.createElement("a");
      link.className = "sb-account-action";
      link.href = "/auth/github";
      link.dataset.action = "sign-in";
      link.textContent = "Sign in";
      account.appendChild(link);
    }
  }

  // Initialize with guest state.
  setUser(null);

  return {
    el,
    setWorkspaces,
    setActiveWorkspace,
    onWorkspaceChange,
    setUser,
    // Back-compat for any earlier callers.
    setWorkspaceLabel(label) {
      // No-op now that we render a real <select>; kept to avoid breakage.
      void label;
    },
    setAvatar(node) {
      const slot = el.querySelector(".sb-avatar");
      if (!slot) return;
      slot.innerHTML = "";
      if (node instanceof Node) slot.appendChild(node);
    }
  };
}

function computeInitials(user) {
  if (!user) return "G";
  const src = user.displayName || user.email || user.userId || "";
  const parts = String(src).trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "U";
  const first = parts[0][0] || "";
  const second = parts.length > 1 ? (parts[1][0] || "") : "";
  return (first + second).toUpperCase() || "U";
}
