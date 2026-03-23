/**
 * Phase 75: Starter API client patterns (TypeScript).
 * Replace BASE and TOKEN for your deployment.
 */
const BASE = process.env.SISKELBOT_URL || "http://localhost:3000";
const TOKEN = process.env.SISKELBOT_API_KEY || "";

async function api(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string>),
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const res = await fetch(`${BASE.replace(/\/$/, "")}/api/v1${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return body;
}

/** Idempotent workspace create (Phase 75) */
export async function createWorkspace(name: string, idempotencyKey: string) {
  return api("/workspaces", {
    method: "POST",
    idempotencyKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type: "personal" }),
  });
}

export async function listContext(workspace = "default") {
  const q = new URLSearchParams({ workspace });
  return api(`/context?${q}`);
}
