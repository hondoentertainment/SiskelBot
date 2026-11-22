/**
 * CORS policy. Reflecting every Origin with credentials lets any site read
 * cookie-authenticated responses. Set CORS_ORIGINS to an explicit list.
 */
export function buildCorsOptions(env = process.env) {
  const raw = String(env.CORS_ORIGINS || "").trim();
  if (!raw) return { origin: false };
  const origin = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin.length) return { origin: false };
  return {
    origin,
    credentials: env.CORS_ALLOW_CREDENTIALS !== "0",
  };
}
