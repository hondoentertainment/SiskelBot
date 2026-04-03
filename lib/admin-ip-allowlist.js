/**
 * Admin IP allowlist middleware.
 *
 * Reads ADMIN_IP_ALLOWLIST env var (comma-separated IPs or CIDRs).
 * Supports exact IP match, /24 and /16 CIDR notation.
 * If the env var is not set, the middleware is a no-op (passes through).
 */

function parseIpv4(ip) {
  // Strip IPv6-mapped prefix (e.g. "::ffff:127.0.0.1" -> "127.0.0.1")
  const cleaned = ip.replace(/^::ffff:/, "");
  const parts = cleaned.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return nums;
}

function ipMatchesCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split("/");
  if (!prefixStr) {
    // Exact match (no CIDR prefix)
    const cleanIp = ip.replace(/^::ffff:/, "");
    return cleanIp === network;
  }
  const prefix = Number(prefixStr);
  if (prefix !== 16 && prefix !== 24) {
    // Only /16 and /24 supported without external deps
    return false;
  }
  const ipParts = parseIpv4(ip);
  const netParts = parseIpv4(network);
  if (!ipParts || !netParts) return false;

  if (prefix === 24) {
    return ipParts[0] === netParts[0] && ipParts[1] === netParts[1] && ipParts[2] === netParts[2];
  }
  // prefix === 16
  return ipParts[0] === netParts[0] && ipParts[1] === netParts[1];
}

export function adminIpAllowlist(req, res, next) {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw) return next(); // no allowlist configured, pass through

  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return next();

  const clientIp = req.ip || req.socket?.remoteAddress || "";
  const allowed = entries.some((entry) => ipMatchesCidr(clientIp, entry));

  if (!allowed) {
    return res.status(403).json({
      error: "IP not allowed",
      code: "IP_FORBIDDEN",
      hint: "Your IP is not in the ADMIN_IP_ALLOWLIST.",
    });
  }
  next();
}
