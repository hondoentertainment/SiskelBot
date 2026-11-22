/**
 * Shared checks for outbound https calls.
 * Blocks loopback, link-local, private, and metadata hosts before a request is sent.
 */
import { lookup as dnsLookup } from "node:dns/promises";

function ipv4Parts(host) {
  const match = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

export function isBlockedIp(address) {
  const host = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (/^\d+$/.test(host)) return true;
  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(host)) return true;
    if (host.startsWith("::ffff:")) return isBlockedIp(host.slice("::ffff:".length));
  }
  return false;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host === "metadata.google.internal"
  ) return true;
  return isBlockedIp(host);
}

export function validatePublicHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "only https URLs are allowed" };
  if (parsed.username || parsed.password) return { ok: false, error: "credentials in URLs are not allowed" };
  const host = parsed.hostname.toLowerCase();
  if (isBlockedHostname(host)) return { ok: false, error: "host is blocked" };
  return {
    ok: true,
    host,
    origin: parsed.origin,
    base: parsed.href.replace(/\/$/, ""),
  };
}

export async function assertResolvedPublicHost(hostname, lookup = dnsLookup) {
  if (isBlockedHostname(hostname)) return { ok: false, error: "host is blocked" };
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: "host did not resolve" };
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return { ok: false, error: "host did not resolve" };
  for (const rec of list) {
    const addr = typeof rec === "string" ? rec : rec?.address;
    if (isBlockedHostname(addr)) return { ok: false, error: "host resolves to a blocked address" };
  }
  return { ok: true };
}
