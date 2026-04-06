/**
 * Headless browser tools — allowlisted URLs only, Playwright optional.
 * Env: AGENT_BROWSER_TOOLS=1. Workspace policy may narrow hosts via agentPolicy.browserAllowedHosts.
 */
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { isUrlAllowedForKnowledge } from "./knowledge-url-fetch.js";
import { resolveWorkspacePath } from "./workspace-path-guard.js";

export function parseEnvBrowserAllowlistEntries() {
  const raw = (process.env.BROWSER_URL_ALLOWLIST || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const agent = (process.env.AGENT_FETCH_ALLOWLIST || "").trim();
  if (agent) {
    return agent
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const know = (process.env.KNOWLEDGE_URL_ALLOWLIST || "").trim();
  return know
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function agentBrowserToolsEnabled() {
  return process.env.AGENT_BROWSER_TOOLS === "1";
}

const DEFAULT_NAV_MS = Math.min(120_000, Math.max(3000, Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS) || 25_000));
const DEFAULT_MAX_TEXT = Math.min(2_000_000, Math.max(4096, Number(process.env.BROWSER_MAX_EXTRACT_CHARS) || 120_000));
const DEFAULT_VIEWPORT_W = Math.min(1920, Math.max(320, Number(process.env.BROWSER_SCREENSHOT_VIEWPORT_WIDTH) || 1280));
const DEFAULT_VIEWPORT_H = Math.min(2160, Math.max(240, Number(process.env.BROWSER_SCREENSHOT_VIEWPORT_HEIGHT) || 720));
const DEFAULT_SCREENSHOT_MAX_BYTES = Math.min(
  4_000_000,
  Math.max(20_000, Number(process.env.BROWSER_MAX_SCREENSHOT_BYTES) || 600_000),
);

/**
 * Normalize workspace browser host entries (same semantics as KNOWLEDGE_URL_ALLOWLIST entries).
 * @param {unknown} workspaceBrowserHosts
 * @returns {string[]}
 */
export function normalizeWorkspaceBrowserHosts(workspaceBrowserHosts) {
  if (!Array.isArray(workspaceBrowserHosts)) return [];
  return workspaceBrowserHosts
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .slice(0, 48);
}

/**
 * @param {string} initialUrl
 * @param {string} finalUrl
 * @param {string[]} [workspaceBrowserHosts] — if non-empty, URL must match deploy allowlist AND this list (narrowing).
 * @returns {{ ok: true } | { ok: false, code: string, error?: string }}
 */
export function assertBrowserNavigationAllowed(initialUrl, finalUrl, workspaceBrowserHosts) {
  const entries = parseEnvBrowserAllowlistEntries();
  if (!entries.length) {
    return {
      ok: false,
      code: "ALLOWLIST_REQUIRED",
      error: "Set BROWSER_URL_ALLOWLIST or AGENT_FETCH_ALLOWLIST or KNOWLEDGE_URL_ALLOWLIST",
    };
  }
  const ws = normalizeWorkspaceBrowserHosts(workspaceBrowserHosts);
  if (!isUrlAllowedForKnowledge(initialUrl, entries)) {
    return { ok: false, code: "URL_NOT_ALLOWED", error: "URL not allowlisted for browser tool" };
  }
  if (ws.length && !isUrlAllowedForKnowledge(initialUrl, ws)) {
    return {
      ok: false,
      code: "URL_NOT_IN_WORKSPACE_ALLOWLIST",
      error: "URL not allowed by workspace browserAllowedHosts policy",
    };
  }
  if (!isUrlAllowedForKnowledge(finalUrl, entries)) {
    return { ok: false, code: "REDIRECT_OUTSIDE_ALLOWLIST", error: `Landing URL not allowlisted: ${finalUrl}` };
  }
  if (ws.length && !isUrlAllowedForKnowledge(finalUrl, ws)) {
    return {
      ok: false,
      code: "REDIRECT_OUTSIDE_WORKSPACE_ALLOWLIST",
      error: `Landing URL not allowed by workspace policy: ${finalUrl}`,
    };
  }
  return { ok: true };
}

/**
 * @param {string} urlString
 * @param {{ waitUntil?: "load"|"domcontentloaded"|"networkidle"; workspaceBrowserHosts?: string[] }} [opts]
 */
export async function browserOpenExtractText(urlString, opts = {}) {
  const u0 = String(urlString || "").trim();
  if (!u0) {
    return { ok: false, code: "URL_REQUIRED", error: "url is required" };
  }
  const pre = assertBrowserNavigationAllowed(u0, u0, opts.workspaceBrowserHosts);
  if (!pre.ok) return pre;

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_UNAVAILABLE",
      error: "Install optional dependency: npm i playwright && npx playwright install chromium",
    };
  }

  const waitUntil = ["load", "domcontentloaded", "networkidle"].includes(opts.waitUntil)
    ? opts.waitUntil
    : "domcontentloaded";
  const navTimeout = DEFAULT_NAV_MS;

  let browser = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto(u0, { timeout: navTimeout, waitUntil });
    const finalUrl = page.url();
    const navOk = assertBrowserNavigationAllowed(u0, finalUrl, opts.workspaceBrowserHosts);
    if (!navOk.ok) return navOk;
    const title = (await page.title().catch(() => "")) || "";
    let text = await page.locator("body").innerText().catch(() => "");
    if (typeof text !== "string") text = "";
    let truncated = false;
    if (text.length > DEFAULT_MAX_TEXT) {
      text = text.slice(0, DEFAULT_MAX_TEXT) + "\n\n…(truncated)";
      truncated = true;
    }
    return {
      ok: true,
      url: u0,
      finalUrl,
      title: title.slice(0, 500),
      text,
      truncated,
    };
  } catch (e) {
    return {
      ok: false,
      code: "BROWSER_ERROR",
      error: String(e?.message || e),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Capture a viewport screenshot. With WORKSPACE_ROOT (via ctx), writes PNG under `.siskelbot/browser-screenshots/`.
 * Otherwise returns base64 JPEG capped by BROWSER_MAX_SCREENSHOT_BYTES.
 *
 * @param {string} urlString
 * @param {{ waitUntil?: string; fullPage?: boolean; workspaceBrowserHosts?: string[]; workspaceFilesystemRoot?: string }} [opts]
 */
export async function browserCaptureScreenshot(urlString, opts = {}) {
  const u0 = String(urlString || "").trim();
  if (!u0) {
    return { ok: false, code: "URL_REQUIRED", error: "url is required" };
  }
  const pre = assertBrowserNavigationAllowed(u0, u0, opts.workspaceBrowserHosts);
  if (!pre.ok) return pre;

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_UNAVAILABLE",
      error: "Install optional dependency: npm i playwright && npx playwright install chromium",
    };
  }

  const waitUntil = ["load", "domcontentloaded", "networkidle"].includes(opts.waitUntil)
    ? opts.waitUntil
    : "domcontentloaded";
  const navTimeout = DEFAULT_NAV_MS;
  const fullPage = opts.fullPage === true;
  const vw = DEFAULT_VIEWPORT_W;
  const vh = DEFAULT_VIEWPORT_H;
  const maxBytes = DEFAULT_SCREENSHOT_MAX_BYTES;

  let browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: vw, height: vh });
    await page.goto(u0, { timeout: navTimeout, waitUntil });
    const finalUrl = page.url();
    const navOk = assertBrowserNavigationAllowed(u0, finalUrl, opts.workspaceBrowserHosts);
    if (!navOk.ok) return navOk;

    const title = ((await page.title().catch(() => "")) || "").slice(0, 500);

    async function shot(type, quality) {
      const buf = await page.screenshot({
        type,
        fullPage,
        ...(type === "jpeg" ? { quality: quality ?? 65 } : {}),
      });
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    }

    let buf = await shot("png");
    let mime = "image/png";
    if (buf.length > maxBytes) {
      for (const q of [70, 55, 40, 28]) {
        buf = await shot("jpeg", q);
        mime = "image/jpeg";
        if (buf.length <= maxBytes) break;
      }
    }
    if (buf.length > maxBytes) {
      return {
        ok: false,
        code: "SCREENSHOT_TOO_LARGE",
        error: `Screenshot exceeds BROWSER_MAX_SCREENSHOT_BYTES (${maxBytes}); reduce viewport or fullPage`,
      };
    }

    const root = typeof opts.workspaceFilesystemRoot === "string" ? opts.workspaceFilesystemRoot.trim() : "";
    if (root) {
      const relDir = `.siskelbot/browser-screenshots`;
      const name = `${randomUUID()}.${mime === "image/jpeg" ? "jpg" : "png"}`;
      const relPath = `${relDir}/${name}`;
      const dirRes = resolveWorkspacePath(root, relDir);
      if (!dirRes.ok) {
        return { ok: false, code: dirRes.code, error: dirRes.error };
      }
      const fileRes = resolveWorkspacePath(root, relPath);
      if (!fileRes.ok) {
        return { ok: false, code: fileRes.code, error: fileRes.error };
      }
      await mkdir(dirRes.absPath, { recursive: true });
      await writeFile(fileRes.absPath, buf);
      return {
        ok: true,
        url: u0,
        finalUrl,
        title,
        storedRelativePath: relPath,
        byteLength: buf.length,
        mime,
        viewport: { width: vw, height: vh },
        fullPage,
      };
    }

    return {
      ok: true,
      url: u0,
      finalUrl,
      title,
      imageBase64: buf.toString("base64"),
      byteLength: buf.length,
      mime,
      viewport: { width: vw, height: vh },
      fullPage,
    };
  } catch (e) {
    return {
      ok: false,
      code: "BROWSER_ERROR",
      error: String(e?.message || e),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
