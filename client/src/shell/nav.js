/**
 * Collapsible left navigation for the SPA shell.
 * Items highlight based on the current router path.
 */
import { router } from "../router.js";

const DEFAULT_ITEMS = [
  { path: "/home", label: "Home", icon: "◉" },
  { path: "/chat", label: "Chat", icon: "◎" },
  { path: "/runs", label: "Runs", icon: "▷" },
  { path: "/knowledge", label: "Knowledge", icon: "□" },
  { path: "/recipes", label: "Recipes", icon: "≡" }
];

export function createNav(items = DEFAULT_ITEMS) {
  const el = document.createElement("nav");
  el.className = "sb-nav";
  el.setAttribute("aria-label", "Primary");

  const list = document.createElement("ul");
  list.className = "sb-nav-list";
  list.setAttribute("role", "list");

  const entries = items.map((item) => {
    const li = document.createElement("li");
    li.className = "sb-nav-item";
    const a = document.createElement("a");
    a.className = "sb-nav-link";
    a.href = item.path;
    a.dataset.path = item.path;
    a.innerHTML = `<span class="sb-nav-icon" aria-hidden="true"></span><span class="sb-nav-label"></span>`;
    a.querySelector(".sb-nav-icon").textContent = item.icon || "•";
    a.querySelector(".sb-nav-label").textContent = item.label;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      router.navigate(item.path);
    });
    li.appendChild(a);
    list.appendChild(li);
    return { item, a };
  });

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "sb-nav-collapse";
  collapseBtn.setAttribute("aria-label", "Toggle navigation");
  collapseBtn.setAttribute("aria-expanded", "true");
  collapseBtn.innerHTML = `<span aria-hidden="true">⟨⟩</span>`;
  collapseBtn.addEventListener("click", () => toggle());

  el.appendChild(list);
  el.appendChild(collapseBtn);

  function setActive(path) {
    const current = (path || "").split("?")[0];
    entries.forEach(({ item, a }) => {
      const isActive = current === item.path || current.startsWith(item.path + "/");
      a.classList.toggle("is-active", isActive);
      if (isActive) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  function toggle(force) {
    const collapsed = typeof force === "boolean"
      ? force
      : !el.classList.contains("is-collapsed");
    el.classList.toggle("is-collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  router.subscribe((ctx) => setActive(ctx.path));

  return { el, setActive, toggle };
}
