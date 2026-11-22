/**
 * Bring-your-own-key for model providers, scoped to a workspace.
 * Keys live in the secrets store. The process env key is the fallback.
 * Stripe live keys are not stored here; an operator sets those in the host environment.
 */
import { getSecretValue, setSecret, deleteSecret } from "./secrets-store.js";
import { sanitizeWorkspace } from "./storage.js";

export const BYOK_PROVIDERS = Object.freeze({
  openai: { env: "OPENAI_API_KEY", secret: "byok_openai" },
  anthropic: { env: "ANTHROPIC_API_KEY", secret: "byok_anthropic" },
  groq: { env: "GROQ_API_KEY", secret: "byok_groq" },
  openrouter: { env: "OPENROUTER_API_KEY", secret: "byok_openrouter" },
});

export function providerForBackend(backend) {
  const name = String(backend || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(BYOK_PROVIDERS, name) ? name : null;
}

function assertKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (key.length < 8 || key.length > 500 || /\s/.test(key)) {
    const err = new Error("apiKey must be a single token between 8 and 500 characters");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return key;
}

export async function resolveWorkspaceProviderKey(workspaceId, provider) {
  const spec = BYOK_PROVIDERS[provider];
  if (!spec) return null;
  const ws = sanitizeWorkspace(workspaceId);
  const stored = await getSecretValue("workspace", ws, spec.secret);
  if (typeof stored === "string" && stored.trim()) {
    return { key: stored.trim(), source: "workspace" };
  }
  const env = (process.env[spec.env] || "").trim();
  if (!env) return null;
  return { key: env, source: "env" };
}

/**
 * Replace Authorization when this workspace has its own key for the backend.
 * Local backends (ollama, vllm) are unchanged.
 */
export async function applyWorkspaceByok(config, workspaceId, backend) {
  if (!config || typeof config !== "object") return config;
  const provider = providerForBackend(backend);
  if (!provider) return config;
  const resolved = await resolveWorkspaceProviderKey(workspaceId, provider);
  if (!resolved || resolved.source !== "workspace") return config;
  return {
    ...config,
    byokProvider: provider,
    headers: {
      ...(config.headers || {}),
      Authorization: `Bearer ${resolved.key}`,
    },
  };
}

export async function listWorkspaceByok(workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const items = [];
  for (const [provider, spec] of Object.entries(BYOK_PROVIDERS)) {
    const stored = await getSecretValue("workspace", ws, spec.secret);
    const hasWorkspace = typeof stored === "string" && stored.trim().length > 0;
    const hasEnv = Boolean((process.env[spec.env] || "").trim());
    items.push({
      provider,
      configured: hasWorkspace,
      last4: hasWorkspace ? stored.trim().slice(-4) : null,
      source: hasWorkspace ? "workspace" : hasEnv ? "env" : null,
    });
  }
  return items;
}

export async function setWorkspaceProviderKey(workspaceId, provider, apiKey) {
  const spec = BYOK_PROVIDERS[provider];
  if (!spec) {
    const err = new Error(`provider must be one of: ${Object.keys(BYOK_PROVIDERS).join(", ")}`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  const key = assertKey(apiKey);
  const ws = sanitizeWorkspace(workspaceId);
  await setSecret("workspace", ws, spec.secret, key, `BYOK ${provider}`);
  return { provider, configured: true, last4: key.slice(-4), source: "workspace" };
}

export async function deleteWorkspaceProviderKey(workspaceId, provider) {
  const spec = BYOK_PROVIDERS[provider];
  if (!spec) {
    const err = new Error(`provider must be one of: ${Object.keys(BYOK_PROVIDERS).join(", ")}`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  const ws = sanitizeWorkspace(workspaceId);
  return deleteSecret("workspace", ws, spec.secret);
}
