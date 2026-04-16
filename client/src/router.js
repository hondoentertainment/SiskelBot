/**
 * History API client router for the SiskelBot SPA shell.
 *
 * Pure functions (compileRoute, matchRoute, resolve) are exported for tests.
 * The stateful Router class wires these to window.history and dispatches
 * navigation events a view layer can subscribe to.
 */

/**
 * Compile a route pattern like "/runs/:id" into a regex + param name list.
 * @param {string} pattern
 * @returns {{pattern: string, regex: RegExp, keys: string[]}}
 */
export function compileRoute(pattern) {
  const keys = [];
  // Split on '/' so we can handle param segments independently of regex escaping.
  const trimmed = pattern.replace(/\/+$/, "") || "/";
  const parts = trimmed.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  });
  let body = parts.join("/");
  if (body === "") body = "/";
  const source = "^" + body + "/?$";
  return { pattern, regex: new RegExp(source), keys };
}

/**
 * Match a concrete path against a compiled route.
 * @param {{regex: RegExp, keys: string[]}} compiled
 * @param {string} path
 * @returns {Record<string,string>|null}
 */
export function matchRoute(compiled, path) {
  const m = compiled.regex.exec(path);
  if (!m) return null;
  const params = {};
  compiled.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1]);
  });
  return params;
}

/**
 * Pure resolver used by both Router.navigate and the router tests.
 * Given a table of route entries and a path, return a resolution descriptor.
 *
 * @param {Array<{pattern:string, compiled:{regex:RegExp,keys:string[]}, loader:Function}>} routes
 * @param {string} path
 * @returns {{status:"match"|"notfound", pattern:string|null, params:Record<string,string>, loader:Function|null}}
 */
export function resolve(routes, path) {
  const clean = (path || "/").split("?")[0].split("#")[0] || "/";
  for (const r of routes) {
    const params = matchRoute(r.compiled, clean);
    if (params) {
      return { status: "match", pattern: r.pattern, params, loader: r.loader };
    }
  }
  return { status: "notfound", pattern: null, params: {}, loader: null };
}

/**
 * Pure helper: run a view loader, swap out the previous view's unmount
 * cleanup, and return the new cleanup (or null).
 *
 * Contract:
 *   - Calls `prevUnmount()` first (if a function). Any throw is swallowed.
 *   - Invokes `loader(ctx)`; awaits if a Promise is returned.
 *   - If the awaited result is a function, it is returned as the new unmount.
 *     Otherwise returns null.
 *   - Any throw from the loader is swallowed and reported via onError; the
 *     returned unmount is null so the next navigation has nothing to clean.
 *
 * Exported for tests — the Router class uses this to bookkeep cleanups.
 *
 * @param {Function|null|undefined} prevUnmount
 * @param {Function|null|undefined} loader
 * @param {any} ctx
 * @param {(err:unknown, where:string)=>void} [onError]
 * @returns {Promise<Function|null>}
 */
export async function runWithLifecycle(prevUnmount, loader, ctx, onError) {
  if (typeof prevUnmount === "function") {
    try { await prevUnmount(); }
    catch (e) { if (onError) onError(e, "unmount"); }
  }
  if (typeof loader !== "function") return null;
  let result;
  try {
    result = loader(ctx);
    if (result && typeof result.then === "function") result = await result;
  } catch (e) {
    if (onError) onError(e, "loader");
    return null;
  }
  return typeof result === "function" ? result : null;
}

export class Router {
  constructor() {
    this.routes = [];
    this.notFound = null;
    this.listeners = new Set();
    this._currentUnmount = null;
    this._onPop = () => this._render(window.location.pathname + window.location.search);
  }

  register(pattern, loader) {
    if (pattern === "*") {
      this.notFound = loader;
      return;
    }
    this.routes.push({ pattern, compiled: compileRoute(pattern), loader });
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    window.addEventListener("popstate", this._onPop);
    this._render(window.location.pathname + window.location.search);
  }

  stop() {
    window.removeEventListener("popstate", this._onPop);
  }

  navigate(path, { replace = false } = {}) {
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", path);
    this._render(path);
  }

  back() {
    window.history.back();
  }

  _render(path) {
    const result = resolve(this.routes, path);
    const loader = result.loader || this.notFound;
    const ctx = { path, pattern: result.pattern, params: result.params, status: result.status };
    for (const fn of this.listeners) {
      try { fn(ctx); } catch (e) { console.error("router listener error", e); }
    }
    // Swap the previous view's unmount for the new one (if any). The view
    // lifecycle contract: mount() may return a function (or Promise of one)
    // that the router calls before the next view mounts. See runWithLifecycle.
    const prev = this._currentUnmount;
    this._currentUnmount = null;
    const onError = (e, where) => console.error(`router ${where} error`, e);
    const pending = runWithLifecycle(prev, loader, ctx, onError)
      .then((next) => {
        // Only store if nothing else replaced us while we were awaiting.
        if (this._currentUnmount === null) this._currentUnmount = next;
      })
      .catch((e) => console.error("router lifecycle error", e));
    this._pendingRender = pending;
    return pending;
  }
}

export const router = new Router();
