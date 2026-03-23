/**
 * Phase 72: Fetch remote text for knowledge indexing with URL allowlist (SSRF-safe).
 * KNOWLEDGE_URL_ALLOWLIST: comma-separated hostnames (e.g. example.com,docs.example.com)
 * or full URL prefixes (https://raw.githubusercontent.com/org/repo/).
 */
function parseAllowlist() {
  const raw = process.env.KNOWLEDGE_URL_ALLOWLIST?.trim() || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} urlString
 * @param {string[]} entries from parseAllowlist()
 */
export function isUrlAllowedForKnowledge(urlString, entries) {
  if (!urlString || !entries.length) return false;
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  for (const e of entries) {
    if (e.startsWith("http://") || e.startsWith("https://")) {
      const base = e.endsWith("/") ? e : `${e}/`;
      if (urlString.startsWith(base) || urlString === e.replace(/\/$/, "")) return true;
      continue;
    }
    const h = e.toLowerCase().replace(/^\.+/, "");
    if (!h) continue;
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

function stripHtmlToText(buf) {
  const s = buf.toString("utf8");
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readBodyWithLimit(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return { error: "Response too large", code: "DOC_TOO_LARGE" };
    return { buf: Buffer.from(ab) };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) return { error: "Response too large", code: "DOC_TOO_LARGE" };
      chunks.push(Buffer.from(value));
    }
  }
  return { buf: Buffer.concat(chunks) };
}

/**
 * GET url after allowlist check; follows redirects re-validating each target.
 * @returns {Promise<{ text: string, finalUrl: string, title?: string } | { error: string, code: string }>}
 */
export async function fetchTextFromAllowedUrl(urlString, opts = {}) {
  const entries = parseAllowlist();
  if (!entries.length) {
    return { error: "KNOWLEDGE_URL_ALLOWLIST is not set or empty", code: "ALLOWLIST_REQUIRED" };
  }

  const maxBytes = opts.maxBytes ?? Math.min(4 * 1024 * 1024, Number(process.env.KNOWLEDGE_FETCH_MAX_BYTES) || 524_288);
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.KNOWLEDGE_FETCH_TIMEOUT_MS) || 15_000);
  let current = urlString.trim();

  for (let hop = 0; hop < 8; hop++) {
    if (!isUrlAllowedForKnowledge(current, entries)) {
      return { error: "URL not in KNOWLEDGE_URL_ALLOWLIST", code: "URL_NOT_ALLOWED" };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "SiskelBot-KnowledgeFetch/1.0", Accept: "text/html,text/plain,application/json,text/markdown,*/*" },
      });
    } catch (e) {
      clearTimeout(t);
      const msg = e.name === "AbortError" ? "Fetch timeout" : e.message;
      return { error: msg, code: "FETCH_FAILED" };
    }
    clearTimeout(t);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { error: "Redirect without Location", code: "FETCH_FAILED" };
      try {
        current = new URL(loc, current).href;
      } catch {
        return { error: "Invalid redirect URL", code: "FETCH_FAILED" };
      }
      continue;
    }

    if (!res.ok) {
      return { error: `HTTP ${res.status}`, code: "FETCH_FAILED" };
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const allowedType =
      ct.includes("text/html") ||
      ct.includes("text/plain") ||
      ct.includes("application/json") ||
      ct.includes("text/markdown") ||
      ct.includes("application/xml") ||
      ct.includes("text/xml");
    if (!allowedType && ct.length > 0) {
      return { error: "Unsupported Content-Type for knowledge fetch", code: "UNSUPPORTED_MEDIA" };
    }

    const body = await readBodyWithLimit(res, maxBytes);
    if (body.error) return body;

    let text;
    if (ct.includes("application/json")) {
      try {
        const j = JSON.parse(body.buf.toString("utf8"));
        text = typeof j === "string" ? j : JSON.stringify(j, null, 2);
      } catch {
        text = body.buf.toString("utf8");
      }
    } else if (ct.includes("text/html")) {
      text = stripHtmlToText(body.buf);
    } else {
      text = body.buf.toString("utf8").trim();
    }

    if (!text || text.length < 1) {
      return { error: "Empty body after fetch", code: "EMPTY_BODY" };
    }

    return { text, finalUrl: current, title: undefined };
  }

  return { error: "Too many redirects", code: "FETCH_FAILED" };
}
