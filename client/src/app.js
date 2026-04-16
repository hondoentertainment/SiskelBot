/**
 * SPA bootstrap: wires the shell, router, and command palette together,
 * registers placeholder routes, and installs global keyboard shortcuts.
 */
import { router } from "./router.js";
import { palette } from "./palette.js";
import { createHeader } from "./shell/header.js";
import { createNav } from "./shell/nav.js";
import { createInspector } from "./shell/inspector.js";
import { createShellGlobals, readPersistedWorkspaceId } from "./shell/shell-globals.js";
import { RealtimeClient } from "./realtime/client.js";

function placeholderView(title, description) {
  return (ctx) => {
    const main = document.getElementById("sb-main");
    if (!main) return;
    const params = ctx && ctx.params ? ctx.params : {};
    const paramBits = Object.keys(params).length
      ? `<p><strong>Params:</strong> <code>${escapeHtml(JSON.stringify(params))}</code></p>`
      : "";
    main.innerHTML = `
      <section class="sb-view" aria-labelledby="view-title">
        <h1 id="view-title"></h1>
        <p class="sb-view-desc"></p>
        ${paramBits}
        <p class="sb-view-note">Placeholder view. Downstream agents register the real view via <code>router.register()</code>.</p>
      </section>
    `;
    main.querySelector("#view-title").textContent = title;
    main.querySelector(".sb-view-desc").textContent = description;
  };
}

function notFoundView() {
  return (ctx) => {
    const main = document.getElementById("sb-main");
    if (!main) return;
    main.innerHTML = `
      <section class="sb-view" aria-labelledby="view-title">
        <h1 id="view-title">Not found</h1>
        <p>The path <code></code> has no registered view.</p>
        <p><a href="/home" data-nav>Back to home</a></p>
      </section>
    `;
    main.querySelector("code").textContent = ctx && ctx.path ? ctx.path : "(unknown)";
    const back = main.querySelector("[data-nav]");
    if (back) back.addEventListener("click", (e) => { e.preventDefault(); router.navigate("/home"); });
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function bootstrap(rootId = "sb-root") {
  const root = document.getElementById(rootId) || document.body;

  const shell = document.createElement("div");
  shell.className = "sb-shell";

  const header = createHeader();
  const nav = createNav();
  const inspector = createInspector();

  const main = document.createElement("main");
  main.id = "sb-main";
  main.className = "sb-main";
  main.setAttribute("role", "main");
  main.setAttribute("tabindex", "-1");

  shell.appendChild(header.el);
  shell.appendChild(nav.el);
  shell.appendChild(main);
  shell.appendChild(inspector.el);
  root.appendChild(shell);

  palette.mount(document.body);

  const realtime = createLazyRealtime("/ws/realtime");
  const shellGlobals = createShellGlobals({ router, palette, realtime, inspector });
  if (typeof window !== "undefined") {
    window.SiskelbotShell = shellGlobals;
  }

  header.onWorkspaceChange((id) => { shellGlobals.setWorkspace(id); });

  // Fetch user + workspaces in the background; degrade gracefully on failure.
  hydrateAuthAndWorkspaces(shellGlobals, header).catch((err) => {
    console.warn("[shell] failed to hydrate auth/workspaces", err);
  });

  // Route table — lazy imports for view modules so the shell loads fast.
  const mountInto = (loader, props) => async (ctx) => {
    const mod = await loader();
    const mountFn = mod.default || mod.mount;
    if (typeof mountFn !== "function") {
      throw new Error(`view loader ${loader.name || "(anonymous)"} has no default export or mount()`);
    }
    return mountFn(main, { ...ctx, ...(props || {}) });
  };

  router.register("/", () => router.navigate("/home", { replace: true }));
  router.register("/home", placeholderView("Home", "Overview of workspace activity."));
  router.register("/chat", mountInto(() => import("./views/chat.js")));
  router.register("/runs", mountInto(() => import("./views/runs.js")));
  router.register("/runs/:id", async (ctx) => {
    const mod = await import("./views/agent-run.js");
    const mountFn = mod.default || mod.mount;
    return mountFn(main, { sessionId: ctx.params.id, apiBase: "/api/v1" });
  });
  router.register("/knowledge", mountInto(() => import("./views/knowledge.js")));
  router.register("/recipes", placeholderView("Recipes", "Saved recipes and automation templates."));
  router.register("*", notFoundView());

  // Palette actions
  const navAction = (path, title, hint) => ({
    id: `go:${path}`, title, hint, run: () => router.navigate(path)
  });
  [
    navAction("/home", "Go to Home", "g h"),
    navAction("/chat", "Go to Chat", "g c"),
    navAction("/runs", "Go to Runs", "g r"),
    navAction("/knowledge", "Go to Knowledge", "g k"),
    navAction("/recipes", "Go to Recipes", "g p"),
    { id: "toggle:nav", title: "Toggle navigation", hint: "Cmd+\\", run: () => { nav.toggle(); toggleShellClass("is-nav-collapsed"); } },
    { id: "toggle:inspector", title: "Toggle inspector", hint: "Cmd+/", run: () => { inspector.toggle(); toggleShellClass("is-inspector-collapsed"); } },
    { id: "help:shortcuts", title: "Show keyboard shortcuts", hint: "?", run: () => showHelp(inspector) },
    { id: "back", title: "Go back", hint: "browser back", run: () => router.back() }
  ].forEach(a => palette.register(a));

  function toggleShellClass(cls) { shell.classList.toggle(cls); }

  installKeyboard({ nav, inspector, shell });

  router.start();

  return { router, palette, header, nav, inspector, shell: shellGlobals, realtime };
}

/**
 * Build a lazy wrapper around RealtimeClient that defers .connect() until
 * the first .subscribe() call. Exposes the same surface views need.
 */
function createLazyRealtime(url) {
  let client = null;
  function ensure() {
    if (client) return client;
    try {
      client = new RealtimeClient({ url });
    } catch (err) {
      console.warn("[shell] RealtimeClient unavailable", err);
      // Stub so callers don't crash in environments without WebSocket.
      client = {
        subscribe() {}, unsubscribe() {}, close() {}, connect() {}
      };
    }
    return client;
  }
  return {
    get url() { return url; },
    get raw() { return client; },
    subscribe(channel, handler, opts) {
      const c = ensure();
      // Lazy-connect on first subscribe.
      if (typeof c.connect === "function" && !c._ws && !c._closed) {
        try { c.connect(); } catch (err) { console.warn("[shell] realtime connect failed", err); }
      }
      return c.subscribe(channel, handler, opts);
    },
    unsubscribe(channel) {
      if (!client) return;
      return client.unsubscribe(channel);
    },
    close() {
      if (!client) return;
      return client.close();
    }
  };
}

async function fetchJsonSafe(path) {
  try {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401) return { status: 401, body: null };
    if (!res.ok) {
      console.warn(`[shell] ${path} returned ${res.status}`);
      return { status: res.status, body: null };
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    console.warn(`[shell] ${path} failed`, err);
    return { status: 0, body: null };
  }
}

function normalizeWorkspaces(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.workspaces)) return body.workspaces;
  return [];
}

async function hydrateAuthAndWorkspaces(shellGlobals, header) {
  const sessionRes = await fetchJsonSafe("/api/v1/auth/session");
  if (sessionRes.status === 401 || !sessionRes.body) {
    shellGlobals.setUser(null);
    shellGlobals.setWorkspaces([]);
    header.setUser(null);
    header.setWorkspaces([], null);
    return;
  }

  const user = sessionRes.body;
  shellGlobals.setUser(user);
  header.setUser(user);

  const wsRes = await fetchJsonSafe("/api/v1/workspaces");
  const workspaces = normalizeWorkspaces(wsRes.body);
  shellGlobals.setWorkspaces(workspaces);

  const persisted = readPersistedWorkspaceId();
  const initial = workspaces.find(w => persisted != null && String(w.id) === String(persisted))
    || workspaces[0]
    || null;

  header.setWorkspaces(workspaces, initial ? initial.id : null);
  if (initial) shellGlobals.setWorkspace(initial.id);
}

function installKeyboard({ nav, inspector, shell }) {
  let chord = null; // "g" when waiting for second key
  let chordTimer = null;

  const clearChord = () => { chord = null; if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; } };

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Palette: Cmd/Ctrl+K
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.toggle();
      return;
    }
    // Toggle inspector: Cmd/Ctrl+/
    if (mod && e.key === "/") {
      e.preventDefault();
      inspector.toggle();
      shell.classList.toggle("is-inspector-collapsed");
      return;
    }
    // Toggle nav: Cmd/Ctrl+\
    if (mod && e.key === "\\") {
      e.preventDefault();
      nav.toggle();
      shell.classList.toggle("is-nav-collapsed");
      return;
    }

    // Help: ? when not typing
    if (e.key === "?" && !isTypingContext(e.target) && !mod) {
      e.preventDefault();
      showHelp(inspector);
      return;
    }

    // Esc closes palette overlay (palette has its own handler, but belt + suspenders)
    if (e.key === "Escape" && palette.open) {
      palette.close();
      return;
    }

    // Navigation chords: g then c/r/k/h/p
    if (isTypingContext(e.target) || mod || e.altKey) return;
    if (chord === "g") {
      const map = { c: "/chat", r: "/runs", k: "/knowledge", h: "/home", p: "/recipes" };
      const target = map[e.key.toLowerCase()];
      if (target) {
        e.preventDefault();
        router.navigate(target);
      }
      clearChord();
      return;
    }
    if (e.key.toLowerCase() === "g") {
      chord = "g";
      chordTimer = setTimeout(clearChord, 1200);
    }
  });
}

function isTypingContext(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function showHelp(inspector) {
  inspector.setTitle("Keyboard shortcuts");
  inspector.setContent(`
    <dl class="sb-help">
      <dt><kbd>⌘K</kbd></dt><dd>Open command palette</dd>
      <dt><kbd>⌘/</kbd></dt><dd>Toggle inspector</dd>
      <dt><kbd>⌘\\</kbd></dt><dd>Toggle navigation</dd>
      <dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>Go to Home</dd>
      <dt><kbd>g</kbd> <kbd>c</kbd></dt><dd>Go to Chat</dd>
      <dt><kbd>g</kbd> <kbd>r</kbd></dt><dd>Go to Runs</dd>
      <dt><kbd>g</kbd> <kbd>k</kbd></dt><dd>Go to Knowledge</dd>
      <dt><kbd>g</kbd> <kbd>p</kbd></dt><dd>Go to Recipes</dd>
      <dt><kbd>?</kbd></dt><dd>Show this help</dd>
      <dt><kbd>Esc</kbd></dt><dd>Close overlays</dd>
    </dl>
  `);
  // Ensure inspector is visible
  const shell = document.querySelector(".sb-shell");
  if (shell && shell.classList.contains("is-inspector-collapsed")) {
    shell.classList.remove("is-inspector-collapsed");
    inspector.toggle(false);
  }
}

if (typeof document !== "undefined" && document.readyState !== "loading") {
  bootstrap();
} else if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => bootstrap());
}
