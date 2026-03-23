/**
 * Phase 88: Optional agent tool hooks via dynamic import (AGENT_HOOKS_MODULE).
 * Module should export async beforeToolCall(name, args, ctx) and/or afterToolCall(name, args, result, ctx).
 * beforeToolCall may return { block: true, reason } or { args: patchedArgs }.
 */
import { pathToFileURL } from "url";
import { resolve } from "path";

let _hooks = null;
let _loadError = null;

async function loadHooks() {
  if (_hooks !== null || _loadError) return _hooks;
  const modPath = (process.env.AGENT_HOOKS_MODULE || "").trim();
  if (!modPath) {
    _hooks = false;
    return _hooks;
  }
  try {
    const abs = resolve(process.cwd(), modPath);
    const m = await import(pathToFileURL(abs).href);
    _hooks = {
      beforeToolCall: typeof m.beforeToolCall === "function" ? m.beforeToolCall : null,
      afterToolCall: typeof m.afterToolCall === "function" ? m.afterToolCall : null,
    };
  } catch (e) {
    _loadError = e;
    console.warn("[agent-hooks] AGENT_HOOKS_MODULE load failed:", e.message);
    _hooks = false;
  }
  return _hooks;
}

/**
 * @returns {Promise<{ block?: boolean, reason?: string, args?: object }>}
 */
export async function invokeBeforeToolCall(name, args, ctx) {
  const h = await loadHooks();
  if (!h || !h.beforeToolCall) return {};
  try {
    const r = await h.beforeToolCall(name, args, ctx);
    if (r && r.block) return { block: true, reason: String(r.reason || "blocked") };
    if (r && r.args && typeof r.args === "object") return { args: r.args };
  } catch (e) {
    return { block: true, reason: String(e?.message || e) };
  }
  return {};
}

export async function invokeAfterToolCall(name, args, result, ctx) {
  const h = await loadHooks();
  if (!h || !h.afterToolCall) return;
  try {
    await h.afterToolCall(name, args, result, ctx);
  } catch (e) {
    console.warn("[agent-hooks] afterToolCall error:", e.message);
  }
}
