/**
 * Phase 5 (B5.1): Headless browser text extraction — allowlisted URLs only, Playwright optional.
 * Validates final URL after redirects (SSRF). Env: AGENT_BROWSER_TOOLS=1.
 */
import { isUrlAllowedForKnowledge } from "./knowledge-url-fetch.js";

function parseBrowserAllowlistEntries() {
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

/**
 * @param {string} urlString
 * @param {{ waitUntil?: "load"|"domcontentloaded"|"networkidle" }} [opts]
 * @returns {Promise<{ ok: true, url: string, finalUrl: string, title: string, text: string, truncated: boolean } | { ok: false, code: string, error?: string }>}
 */
export async function browserOpenExtractText(urlString, opts = {}) {
  const entries = parseBrowserAllowlistEntries();
  if (!entries.length) {
    return {
      ok: false,
      code: "ALLOWLIST_REQUIRED",
      error: "Set BROWSER_URL_ALLOWLIST or AGENT_FETCH_ALLOWLIST or KNOWLEDGE_URL_ALLOWLIST",
    };
  }
  const u0 = String(urlString || "").trim();
  if (!u0) {
    return { ok: false, code: "URL_REQUIRED", error: "url is required" };
  }
  if (!isUrlAllowedForKnowledge(u0, entries)) {
    return { ok: false, code: "URL_NOT_ALLOWED", error: "URL not allowlisted for browser tool" };
  }

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
    if (!isUrlAllowedForKnowledge(finalUrl, entries)) {
      return { ok: false, code: "REDIRECT_OUTSIDE_ALLOWLIST", error: `Landing URL not allowlisted: ${finalUrl}` };
    }
    const title = (await page.title().catch(() => "")) || "";
    let text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
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
