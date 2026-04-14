/**
 * Right-side collapsible inspector drawer.
 * Hosts a context-sensitive content slot that views can populate
 * via setContent(node) or setContent(htmlString).
 */

export function createInspector() {
  const el = document.createElement("aside");
  el.className = "sb-inspector";
  el.setAttribute("aria-label", "Inspector");
  el.setAttribute("role", "complementary");
  el.innerHTML = `
    <div class="sb-inspector-header">
      <h2 class="sb-inspector-title">Inspector</h2>
      <button class="sb-inspector-close" type="button"
              aria-label="Close inspector">×</button>
    </div>
    <div class="sb-inspector-body" tabindex="-1"></div>
  `;

  const body = el.querySelector(".sb-inspector-body");
  const title = el.querySelector(".sb-inspector-title");
  el.querySelector(".sb-inspector-close").addEventListener("click", () => toggle(true));

  function setTitle(text) { title.textContent = text || "Inspector"; }

  function setContent(content) {
    body.innerHTML = "";
    if (!content) return;
    if (typeof content === "string") {
      body.innerHTML = content;
    } else if (content instanceof Node) {
      body.appendChild(content);
    }
  }

  function clear() {
    body.innerHTML = "";
    setTitle("Inspector");
  }

  function toggle(force) {
    const collapsed = typeof force === "boolean"
      ? force
      : !el.classList.contains("is-collapsed");
    el.classList.toggle("is-collapsed", collapsed);
    el.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }

  // Default state: open but empty.
  el.setAttribute("aria-hidden", "false");

  return { el, setTitle, setContent, clear, toggle };
}
