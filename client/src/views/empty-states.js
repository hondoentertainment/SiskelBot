/**
 * Shared empty-state renderer for SiskelBot SPA views.
 *
 * Usage: import { renderEmptyState } from "./empty-states.js";
 *        container.innerHTML = renderEmptyState("chat");
 *
 * Each empty state renders a centered card with an SVG icon, title,
 * description, and a call-to-action button. Views import this module
 * and inject the returned HTML string when their data list is empty.
 */

// ── SVG icons (24x24, single-color, minimal) ───────────────────────────────

const ICON_CHAT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M20 2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4l4 4 4-4h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 9h10v2H7V9zm7 4H7v-2h7v2z"/></svg>`;

const ICON_ROBOT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2a1 1 0 0 1 1 1v2h3a3 3 0 0 1 3 3v2h1a1 1 0 1 1 0 2h-1v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4H4a1 1 0 1 1 0-2h1V8a3 3 0 0 1 3-3h3V3a1 1 0 0 1 1-1zM9 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>`;

const ICON_BOOK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M21 4c-.55 0-1 .45-1 1v11H6c-1.1 0-2 .9-2 2s.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-.55-.45-1-1-1zM3 6v14c0 .55.45 1 1 1h.17C4.06 20.69 4 20.35 4 20V6c0-1.1.9-2 2-2h13c0-1.1-.9-2-2-2H6C4.34 2 3 3.34 3 5v1z"/></svg>`;

const ICON_RECIPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M4 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4zm4 2v2h8V6H8zm0 4v2h8v-2H8zm0 4v2h5v-2H8z"/></svg>`;

const ICON_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;

// ── Empty state definitions ─────────────────────────────────────────────────

const STATES = {
  chat: {
    icon: ICON_CHAT,
    title: "Start your first conversation",
    desc: "Type a message in the composer below and press Send or Cmd+Enter to chat with the model.",
    cta: "New Chat",
  },
  runs: {
    icon: ICON_ROBOT,
    title: "No agent runs yet",
    desc: "Agent runs appear here when you start an agent session. Agents can plan, call tools, and complete multi-step tasks.",
    cta: "Start a Run",
  },
  knowledge: {
    icon: ICON_BOOK,
    title: "Your knowledge base is empty",
    desc: "Add your first document to give the assistant context about your project, team, or domain.",
    cta: "Add Document",
  },
  recipes: {
    icon: ICON_RECIPE,
    title: "No recipes created",
    desc: "Create your first recipe to save a reusable sequence of agent tool calls you can run on demand.",
    cta: "New Recipe",
  },
  default: {
    icon: ICON_FOLDER,
    title: "Nothing here yet",
    desc: "This section is empty. Get started by creating your first item.",
    cta: "Get Started",
  },
};

// ── Renderer ────────────────────────────────────────────────────────────────

/**
 * Return an HTML string for a friendly empty-state card.
 *
 * @param {"chat"|"runs"|"knowledge"|"recipes"|"default"} type
 * @returns {string} HTML string
 */
export function renderEmptyState(type) {
  const s = STATES[type] || STATES.default;
  return [
    `<div class="es-empty">`,
    `<div class="es-icon">${s.icon}</div>`,
    `<h2 class="es-title">${s.title}</h2>`,
    `<p class="es-desc">${s.desc}</p>`,
    `<button class="es-cta">${s.cta}</button>`,
    `</div>`,
  ].join("");
}
