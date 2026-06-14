/**
 * Shell globals: the singleton object exposed as window.SiskelbotShell.
 *
 * Exports:
 *   - createEmitter(): tiny on/off/emit event emitter (pure, testable).
 *   - createShellGlobals({ router, palette, realtime, inspector }):
 *       returns the SiskelbotShell object with router/palette/realtime/
 *       inspector handles, mutable user/workspace/workspaces fields,
 *       setWorkspace(id), and on/off/emit forwarded from the emitter.
 *
 * Events:
 *   - 'workspace:change' — payload is the new workspace object (or null).
 *   - 'user:change'      — payload is the new user object (or null).
 *
 * Workspace selection is persisted to localStorage under the key
 * "siskelbot:workspace" so it survives reload.
 */

const STORAGE_KEY = "siskelbot:workspace";

/**
 * Tiny event emitter. Pure — no DOM, no globals.
 * Handlers added during emit are NOT invoked for the in-flight emit;
 * handlers removed during emit ARE skipped if not yet called.
 */
export function createEmitter() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();
  return {
    on(event, handler) {
      if (typeof event !== "string" || typeof handler !== "function") return;
      let set = map.get(event);
      if (!set) { set = new Set(); map.set(event, set); }
      set.add(handler);
    },
    off(event, handler) {
      const set = map.get(event);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) map.delete(event);
    },
    emit(event, payload) {
      const set = map.get(event);
      if (!set || set.size === 0) return;
      // snapshot so handlers added/removed during emit don't break iteration
      const snapshot = Array.from(set);
      for (const fn of snapshot) {
        if (!set.has(fn)) continue;
        try { fn(payload); } catch (e) {
          // eslint-disable-next-line no-console
          console.error("shell-globals emitter handler error", e);
        }
      }
    },
    _events: map, // exposed for tests
  };
}

function safeStorage() {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { /* ignore */ }
  return null;
}

export function readPersistedWorkspaceId() {
  const ls = safeStorage();
  if (!ls) return null;
  try { return ls.getItem(STORAGE_KEY); } catch { return null; }
}

export function persistWorkspaceId(id) {
  const ls = safeStorage();
  if (!ls) return;
  try {
    if (id == null) ls.removeItem(STORAGE_KEY);
    else ls.setItem(STORAGE_KEY, String(id));
  } catch { /* ignore */ }
}

/**
 * Build the SiskelbotShell singleton.
 * @param {{router:any, palette:any, realtime:any, inspector:any}} deps
 */
export function createShellGlobals(deps) {
  const emitter = createEmitter();
  const shell = {
    router: deps.router,
    palette: deps.palette,
    realtime: deps.realtime,
    inspector: deps.inspector,
    user: null,
    workspace: null,
    workspaces: [],
    setWorkspace(id) {
      const next = (this.workspaces || []).find(w => String(w.id) === String(id)) || null;
      if (!next) return null;
      if (this.workspace && String(this.workspace.id) === String(next.id)) return next;
      this.workspace = next;
      persistWorkspaceId(next.id);
      emitter.emit("workspace:change", next);
      return next;
    },
    setUser(user) {
      this.user = user || null;
      emitter.emit("user:change", this.user);
    },
    setWorkspaces(list) {
      this.workspaces = Array.isArray(list) ? list.slice() : [];
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
  return shell;
}

export const SHELL_STORAGE_KEY = STORAGE_KEY;
