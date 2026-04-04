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

/** Agent chat (OpenAI-compatible path on server root, not under /api/v1) */
export async function chatCompletions(body: Record<string, unknown>) {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN } : {}),
  };
  const res = await fetch(`${BASE.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res;
}

/** Example: single-agent with budgets and allowlists (merge with your messages/model) */
export async function agentChatExample() {
  return chatCompletions({
    model: process.env.SISKELBOT_MODEL || "gpt-4o-mini",
    stream: true,
    agentMode: true,
    messages: [{ role: "user", content: "List context titles only, one line." }],
    agentOptions: {
      workspace: "default",
      allowExecution: false,
      maxIterations: 4,
      toolChoice: "auto",
    },
  });
}
