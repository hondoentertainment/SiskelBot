/**
 * White-label / custom branding per workspace.
 *
 * Storage: data/branding/{workspaceId}.json via json-path-store.
 * Falls back to default SiskelBot branding when not configured.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_BRANDING = {
  appName: "SiskelBot",
  primaryColor: "#2563eb",
  logoUrl: "/icon.svg",
  faviconUrl: "",
  customCss: "",
};

const MAX_APP_NAME_LEN = 100;
const MAX_URL_LEN = 2048;
const MAX_COLOR_LEN = 30;
const MAX_CSS_LEN = 32_000;

function brandingPath(workspaceId) {
  return join(getDataDir(), "branding", `${workspaceId}.json`);
}

function sanitizeColor(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim().slice(0, MAX_COLOR_LEN);
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed;
  return null;
}

function sanitizeUrl(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim().slice(0, MAX_URL_LEN);
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return trimmed;
  } catch {
    // invalid URL
  }
  return "";
}

/**
 * Get branding for a workspace. Falls back to defaults for missing fields.
 * @param {string} workspaceId
 * @returns {Promise<{appName: string, logoUrl: string, primaryColor: string, faviconUrl: string, customCss: string}>}
 */
export async function getBranding(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    return { ...DEFAULT_BRANDING };
  }
  const stored = await readJsonPath(brandingPath(workspaceId), null);
  if (!stored || typeof stored !== "object" || !stored.appName) {
    return { ...DEFAULT_BRANDING };
  }
  return {
    appName: stored.appName || DEFAULT_BRANDING.appName,
    logoUrl: stored.logoUrl || DEFAULT_BRANDING.logoUrl,
    primaryColor: stored.primaryColor || DEFAULT_BRANDING.primaryColor,
    faviconUrl: stored.faviconUrl || DEFAULT_BRANDING.faviconUrl,
    customCss: stored.customCss || DEFAULT_BRANDING.customCss,
  };
}

/**
 * Set (overwrite) branding for a workspace.
 * @param {string} workspaceId
 * @param {object} branding
 * @returns {Promise<{appName: string, logoUrl: string, primaryColor: string, faviconUrl: string, customCss: string}>}
 */
export async function setBranding(workspaceId, branding) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!branding || typeof branding !== "object") {
    throw new Error("branding object is required");
  }

  const normalized = {
    appName: typeof branding.appName === "string"
      ? branding.appName.trim().slice(0, MAX_APP_NAME_LEN) || DEFAULT_BRANDING.appName
      : DEFAULT_BRANDING.appName,
    primaryColor: sanitizeColor(branding.primaryColor) || DEFAULT_BRANDING.primaryColor,
    logoUrl: sanitizeUrl(branding.logoUrl) || DEFAULT_BRANDING.logoUrl,
    faviconUrl: sanitizeUrl(branding.faviconUrl) || DEFAULT_BRANDING.faviconUrl,
    customCss: typeof branding.customCss === "string"
      ? branding.customCss.trim().slice(0, MAX_CSS_LEN)
      : "",
  };

  const path = brandingPath(workspaceId);
  await withPathLock(path, async () => {
    await writeJsonPath(path, normalized);
  });

  return normalized;
}

/**
 * Replace template placeholders with branding values.
 * Supported placeholders: {{appName}}, {{logoUrl}}, {{primaryColor}}, {{faviconUrl}}, {{customCss}}
 * @param {string} template - HTML string with placeholders
 * @param {object} branding - Branding object
 * @returns {string}
 */
export function renderBrandedPage(template, branding) {
  if (typeof template !== "string") return "";
  const b = branding && typeof branding === "object" ? branding : DEFAULT_BRANDING;
  return template
    .replace(/\{\{appName\}\}/g, escapeHtml(b.appName || DEFAULT_BRANDING.appName))
    .replace(/\{\{logoUrl\}\}/g, escapeHtml(b.logoUrl || DEFAULT_BRANDING.logoUrl))
    .replace(/\{\{primaryColor\}\}/g, escapeHtml(b.primaryColor || DEFAULT_BRANDING.primaryColor))
    .replace(/\{\{faviconUrl\}\}/g, escapeHtml(b.faviconUrl || DEFAULT_BRANDING.faviconUrl))
    .replace(/\{\{customCss\}\}/g, b.customCss || "");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { DEFAULT_BRANDING };
