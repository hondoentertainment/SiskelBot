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

export class Router {
  constructor() {
    this.routes = [];
    this.notFound = null;
    this.listeners = new Set();
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
    if (loader) {
      try { loader(ctx); } catch (e) { console.error("router loader error", e); }
    }
  }
}

export const router = new Router();
