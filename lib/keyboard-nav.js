// @ts-check
/**
 * Phase 70.3: Keyboard navigation.
 *
 * A registry of keyboard shortcuts with conflict detection, plus a
 * tab-order audit that flags common mouse-only anti-patterns.
 *
 * Exports:
 *   - registerShortcut
 *   - listShortcuts
 *   - auditTabOrder
 *   - resolveConflicts
 *   - exportBindings
 *
 * @module keyboard-nav
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "keyboard-nav.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, shortcuts: {} });
  if (!data.shortcuts || typeof data.shortcuts !== "object") data.shortcuts = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, shortcuts: data.shortcuts || {} });
}

/**
 * Normalize a shortcut spec ("Ctrl+S", "ctrl + s", "CMD+SHIFT+p") into
 * a canonical form: modifiers sorted in Ctrl+Alt+Shift+Meta order,
 * then the key in lowercase.
 *
 * @param {string} keys
 * @returns {string}
 */
export function normalizeShortcut(keys) {
  if (!keys || typeof keys !== "string") throw new Error("keys is required");
  const parts = keys.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error("empty shortcut");
  /** @type {Set<string>} */
  const mods = new Set();
  let mainKey = "";
  for (const p of parts) {
    if (p === "ctrl" || p === "control") mods.add("ctrl");
    else if (p === "alt" || p === "option") mods.add("alt");
    else if (p === "shift") mods.add("shift");
    else if (p === "meta" || p === "cmd" || p === "command" || p === "super") mods.add("meta");
    else mainKey = p;
  }
  if (!mainKey) throw new Error("shortcut must include a key");
  const order = ["ctrl", "alt", "shift", "meta"];
  const sorted = order.filter((m) => mods.has(m));
  return [...sorted, mainKey].join("+");
}

/**
 * Register (or replace) a shortcut binding.
 *
 * @param {{ id: string, keys: string, description?: string, scope?: string }} spec
 * @returns {Promise<object>}
 */
export async function registerShortcut(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  if (!spec.keys || typeof spec.keys !== "string") throw new Error("keys is required");
  const canonical = normalizeShortcut(spec.keys);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: spec.id,
      keys: canonical,
      rawKeys: spec.keys,
      description: typeof spec.description === "string" ? spec.description : "",
      scope: typeof spec.scope === "string" ? spec.scope : "global",
      createdAt: data.shortcuts[spec.id]?.createdAt || now,
      updatedAt: now,
    };
    data.shortcuts[spec.id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * List every registered shortcut.
 * @param {{ scope?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listShortcuts(opts = {}) {
  const data = await loadStore();
  let out = Object.values(data.shortcuts || {});
  if (opts.scope) out = out.filter((s) => s.scope === opts.scope);
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

/**
 * Return every pair of shortcuts that collide on the same keys
 * within the same scope.
 *
 * @returns {Promise<Array<{ keys: string, scope: string, ids: string[] }>>}
 */
export async function resolveConflicts() {
  const shortcuts = await listShortcuts();
  /** @type {Map<string, string[]>} */
  const byKey = new Map();
  for (const s of shortcuts) {
    const k = `${s.scope}|${s.keys}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s.id);
  }
  /** @type {Array<{ keys: string, scope: string, ids: string[] }>} */
  const conflicts = [];
  for (const [key, ids] of byKey.entries()) {
    if (ids.length <= 1) continue;
    const [scope, keys] = key.split("|");
    conflicts.push({ keys, scope, ids });
  }
  return conflicts;
}

/**
 * Audit an array of focusable element descriptors in document order
 * for tab-order issues. Elements look like:
 *   { tag, tabIndex?, disabled?, hidden?, visible?, focusable? }
 *
 * Issues flagged:
 *   - positive tabindex (>0) -- against WAI-ARIA APG guidance
 *   - focusable element marked hidden but not disabled
 *   - focusable mouse-only elements (div/span with onClick but no
 *     tabindex / role="button")
 *
 * @param {Array<object>} elements
 * @returns {{ issues: object[], elementCount: number }}
 */
export function auditTabOrder(elements) {
  if (!Array.isArray(elements)) return { issues: [], elementCount: 0 };
  /** @type {object[]} */
  const issues = [];
  elements.forEach((el, idx) => {
    if (!el || typeof el !== "object") return;
    const tag = String(el.tag || "").toLowerCase();
    const tabIndex = Number.isFinite(Number(el.tabIndex)) ? Number(el.tabIndex) : null;
    if (tabIndex != null && tabIndex > 0) {
      issues.push({ index: idx, tag, severity: "warning", message: `positive tabindex (${tabIndex}) disrupts flow` });
    }
    if (el.focusable && el.hidden && !el.disabled) {
      issues.push({ index: idx, tag, severity: "error", message: "focusable element is hidden but not disabled" });
    }
    if ((tag === "div" || tag === "span") && el.onClick && tabIndex == null && !el.role) {
      issues.push({ index: idx, tag, severity: "error", message: "click-only element is not keyboard focusable" });
    }
  });
  return { issues, elementCount: elements.length };
}

/**
 * Export all bindings as a plain object suitable for a settings
 * file or UI reference.
 *
 * @returns {Promise<object>}
 */
export async function exportBindings() {
  const shortcuts = await listShortcuts();
  /** @type {Record<string, object[]>} */
  const byScope = {};
  for (const s of shortcuts) {
    if (!byScope[s.scope]) byScope[s.scope] = [];
    byScope[s.scope].push({ id: s.id, keys: s.keys, description: s.description });
  }
  return {
    version: STORE_VERSION,
    generatedAt: new Date().toISOString(),
    scopes: byScope,
    count: shortcuts.length,
  };
}
