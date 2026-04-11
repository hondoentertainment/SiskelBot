/**
 * HashiCorp Vault KV v2 secret provider.
 *
 * Uses dynamic import of `node-vault` when available, falling back to plain
 * fetch calls against the Vault HTTP API. Configuration is read from env:
 *   VAULT_ADDR          - Vault URL (e.g. https://vault.example.com)
 *   VAULT_TOKEN         - Vault token for authentication
 *   VAULT_NAMESPACE     - (optional) Vault namespace (Enterprise)
 *   VAULT_KV_MOUNT      - KV v2 mount point (default: "secret")
 *   VAULT_SECRET_PREFIX - prefix applied to all secret ids (default: "siskelbot")
 *
 * Exports: getSecret(id), setSecret(id, value), deleteSecret(id), listSecrets()
 */

const DEFAULT_MOUNT = "secret";
const DEFAULT_PREFIX = "siskelbot";

function config() {
  const addr = (process.env.VAULT_ADDR || "").replace(/\/$/, "");
  const token = process.env.VAULT_TOKEN || "";
  const mount = process.env.VAULT_KV_MOUNT || DEFAULT_MOUNT;
  const prefix = process.env.VAULT_SECRET_PREFIX || DEFAULT_PREFIX;
  const namespace = process.env.VAULT_NAMESPACE || "";
  return { addr, token, mount, prefix, namespace };
}

function secretPath(id) {
  const { prefix } = config();
  const clean = String(id).replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${clean}` : clean;
}

async function getClient() {
  try {
    const mod = await import("node-vault");
    const vault = mod.default || mod;
    const { addr, token, namespace } = config();
    return vault({ apiVersion: "v1", endpoint: addr, token, namespace: namespace || undefined });
  } catch {
    return null;
  }
}

async function fetchVault(method, path, body) {
  const { addr, token, namespace } = config();
  if (!addr) throw new Error("VAULT_ADDR not configured");
  if (!token) throw new Error("VAULT_TOKEN not configured");
  const url = `${addr}/v1/${path}`;
  const headers = { "X-Vault-Token": token, "Content-Type": "application/json" };
  if (namespace) headers["X-Vault-Namespace"] = namespace;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Vault ${method} ${path} failed: ${res.status} ${txt}`);
  }
  if (res.status === 204) return {};
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function getSecret(id) {
  if (!id) throw new Error("getSecret: id required");
  const { mount } = config();
  const path = `${mount}/data/${secretPath(id)}`;
  const client = await getClient();
  if (client && typeof client.read === "function") {
    try {
      const result = await client.read(path);
      const payload = result?.data?.data;
      if (!payload) return null;
      return {
        id,
        value: payload.value,
        version: result?.data?.metadata?.version || 1,
        updatedAt: result?.data?.metadata?.created_time || null,
      };
    } catch (e) {
      if (String(e.message || "").includes("404")) return null;
      throw e;
    }
  }
  const result = await fetchVault("GET", path);
  if (!result) return null;
  const payload = result?.data?.data;
  if (!payload) return null;
  return {
    id,
    value: payload.value,
    version: result?.data?.metadata?.version || 1,
    updatedAt: result?.data?.metadata?.created_time || null,
  };
}

export async function setSecret(id, value) {
  if (!id) throw new Error("setSecret: id required");
  if (value == null) throw new Error("setSecret: value required");
  const { mount } = config();
  const path = `${mount}/data/${secretPath(id)}`;
  const body = { data: { value: String(value) } };
  const client = await getClient();
  if (client && typeof client.write === "function") {
    const result = await client.write(path, body);
    return {
      id,
      version: result?.data?.version || 1,
      updatedAt: result?.data?.created_time || new Date().toISOString(),
    };
  }
  const result = await fetchVault("POST", path, body);
  return {
    id,
    version: result?.data?.version || 1,
    updatedAt: result?.data?.created_time || new Date().toISOString(),
  };
}

export async function deleteSecret(id) {
  if (!id) throw new Error("deleteSecret: id required");
  const { mount } = config();
  // KV v2 metadata delete removes all versions.
  const path = `${mount}/metadata/${secretPath(id)}`;
  const client = await getClient();
  if (client && typeof client.delete === "function") {
    try {
      await client.delete(path);
      return true;
    } catch (e) {
      if (String(e.message || "").includes("404")) return false;
      throw e;
    }
  }
  const result = await fetchVault("DELETE", path);
  return result !== null;
}

export async function listSecrets() {
  const { mount, prefix } = config();
  const listPath = `${mount}/metadata/${prefix}?list=true`;
  const client = await getClient();
  if (client && typeof client.list === "function") {
    try {
      const result = await client.list(`${mount}/metadata/${prefix}`);
      const keys = result?.data?.keys || [];
      return keys.map((k) => ({ id: String(k).replace(/\/$/, "") }));
    } catch (e) {
      if (String(e.message || "").includes("404")) return [];
      throw e;
    }
  }
  const result = await fetchVault("GET", listPath);
  if (!result) return [];
  const keys = result?.data?.keys || [];
  return keys.map((k) => ({ id: String(k).replace(/\/$/, "") }));
}
