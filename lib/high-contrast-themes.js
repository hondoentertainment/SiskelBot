// @ts-check
/**
 * Phase 70.2: High-contrast theme support.
 *
 * Pure-JavaScript implementation of the WCAG 2.1 relative luminance
 * and contrast ratio formulas, plus a small theme catalog with
 * reduced-motion metadata.
 *
 * Exports:
 *   - computeContrast
 *   - suggestPairs
 *   - listThemes
 *   - createTheme
 *   - getTheme
 *
 * @module high-contrast-themes
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
  return join(getDataDir(), "high-contrast-themes.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, themes: {} });
  if (!data.themes || typeof data.themes !== "object") data.themes = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, themes: data.themes || {} });
}

/**
 * Parse a CSS hex color string into [r, g, b] ints (0-255). Accepts
 * 3, 4, 6, or 8 character forms with an optional leading hash.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function parseHex(hex) {
  if (!hex || typeof hex !== "string") throw new Error("hex is required");
  let s = hex.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3 || s.length === 4) {
    s = s.split("").map((c) => c + c).join("");
  }
  if (s.length !== 6 && s.length !== 8) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  return [r, g, b];
}

function channelLuminance(c) {
  const v = c / 255;
  if (v <= 0.03928) return v / 12.92;
  return Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of an sRGB color.
 * @param {string} hex
 * @returns {number}
 */
export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  const R = channelLuminance(r);
  const G = channelLuminance(g);
  const B = channelLuminance(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG contrast ratio between two colors.
 * @param {string} fg
 * @param {string} bg
 * @returns {number}
 */
export function computeContrast(fg, bg) {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 1000) / 1000;
}

/**
 * From a list of candidate colors, return every pair (fg, bg) that
 * meets a minimum contrast ratio. Useful for building a WCAG-AA
 * palette from a brand color list.
 *
 * @param {string[]} colors
 * @param {{ minRatio?: number }} [opts]
 * @returns {Array<{ fg: string, bg: string, ratio: number, grade: string }>}
 */
export function suggestPairs(colors, opts = {}) {
  if (!Array.isArray(colors) || colors.length < 2) return [];
  const minRatio = Number.isFinite(opts.minRatio) ? opts.minRatio : 4.5;
  /** @type {Array<{ fg: string, bg: string, ratio: number, grade: string }>} */
  const out = [];
  for (const fg of colors) {
    for (const bg of colors) {
      if (fg === bg) continue;
      let ratio;
      try {
        ratio = computeContrast(fg, bg);
      } catch (_) {
        continue;
      }
      if (ratio < minRatio) continue;
      let grade = "fail";
      if (ratio >= 7) grade = "AAA";
      else if (ratio >= 4.5) grade = "AA";
      else if (ratio >= 3) grade = "AA-large";
      out.push({ fg, bg, ratio, grade });
    }
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

/**
 * Save a theme in the catalog.
 *
 * @param {{ id: string, name?: string, colors: Record<string,string>, reducedMotion?: boolean }} spec
 * @returns {Promise<object>}
 */
export async function createTheme(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  if (!spec.colors || typeof spec.colors !== "object") throw new Error("colors is required");
  // Validate all colors.
  for (const [key, val] of Object.entries(spec.colors)) {
    if (typeof val !== "string") throw new Error(`color "${key}" must be a string`);
    parseHex(val);
  }
  // Compute contrast ratios for a few canonical pairs if present.
  const ratios = {};
  if (spec.colors.fg && spec.colors.bg) {
    ratios.fgBg = computeContrast(spec.colors.fg, spec.colors.bg);
  }
  if (spec.colors.link && spec.colors.bg) {
    ratios.linkBg = computeContrast(spec.colors.link, spec.colors.bg);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: spec.id,
      name: typeof spec.name === "string" ? spec.name : spec.id,
      colors: { ...spec.colors },
      reducedMotion: spec.reducedMotion === true,
      ratios,
      createdAt: data.themes[spec.id]?.createdAt || now,
      updatedAt: now,
    };
    data.themes[spec.id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Fetch a theme by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getTheme(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.themes[id] || null;
}

/**
 * List all themes.
 * @returns {Promise<object[]>}
 */
export async function listThemes() {
  const data = await loadStore();
  return Object.values(data.themes || {});
}
