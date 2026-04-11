/**
 * AWS Secrets Manager provider.
 *
 * Uses dynamic import of `@aws-sdk/client-secrets-manager` when available,
 * falling back to AWS SigV4-less HTTP calls are not attempted — if the SDK
 * is missing, provider calls throw with a clear message.
 *
 * Configuration env:
 *   AWS_REGION              - Region (default: us-east-1)
 *   AWS_SECRETS_PREFIX      - Prefix for secret names (default: "siskelbot/")
 *   AWS_ACCESS_KEY_ID       - (standard AWS SDK env)
 *   AWS_SECRET_ACCESS_KEY   - (standard AWS SDK env)
 *
 * Exports: getSecret(id), setSecret(id, value), deleteSecret(id), listSecrets()
 */

const DEFAULT_PREFIX = "siskelbot/";

function config() {
  return {
    region: process.env.AWS_REGION || "us-east-1",
    prefix: process.env.AWS_SECRETS_PREFIX || DEFAULT_PREFIX,
  };
}

function secretName(id) {
  const { prefix } = config();
  const clean = String(id).replace(/^\/+/, "");
  return prefix ? `${prefix}${clean}` : clean;
}

async function getClient() {
  try {
    const mod = await import("@aws-sdk/client-secrets-manager");
    const { SecretsManagerClient } = mod;
    const { region } = config();
    return { mod, client: new SecretsManagerClient({ region }) };
  } catch (e) {
    throw new Error(
      `AWS Secrets Manager SDK not available: ${e.message}. Install @aws-sdk/client-secrets-manager.`
    );
  }
}

export async function getSecret(id) {
  if (!id) throw new Error("getSecret: id required");
  const { mod, client } = await getClient();
  const { GetSecretValueCommand } = mod;
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretName(id) })
    );
    const value = result?.SecretString ?? null;
    return {
      id,
      value,
      version: result?.VersionId || null,
      updatedAt: result?.CreatedDate?.toISOString?.() || null,
    };
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
}

export async function setSecret(id, value) {
  if (!id) throw new Error("setSecret: id required");
  if (value == null) throw new Error("setSecret: value required");
  const { mod, client } = await getClient();
  const { PutSecretValueCommand, CreateSecretCommand } = mod;
  const name = secretName(id);
  try {
    const result = await client.send(
      new PutSecretValueCommand({ SecretId: name, SecretString: String(value) })
    );
    return {
      id,
      version: result?.VersionId || null,
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      const result = await client.send(
        new CreateSecretCommand({ Name: name, SecretString: String(value) })
      );
      return {
        id,
        version: result?.VersionId || null,
        updatedAt: new Date().toISOString(),
      };
    }
    throw e;
  }
}

export async function deleteSecret(id) {
  if (!id) throw new Error("deleteSecret: id required");
  const { mod, client } = await getClient();
  const { DeleteSecretCommand } = mod;
  try {
    await client.send(
      new DeleteSecretCommand({ SecretId: secretName(id), ForceDeleteWithoutRecovery: true })
    );
    return true;
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return false;
    throw e;
  }
}

export async function listSecrets() {
  const { mod, client } = await getClient();
  const { ListSecretsCommand } = mod;
  const { prefix } = config();
  const out = [];
  let nextToken;
  do {
    const result = await client.send(
      new ListSecretsCommand({
        MaxResults: 100,
        NextToken: nextToken,
        Filters: prefix ? [{ Key: "name", Values: [prefix] }] : undefined,
      })
    );
    for (const entry of result?.SecretList || []) {
      const name = entry.Name || "";
      const id = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
      out.push({
        id,
        updatedAt: entry.LastChangedDate?.toISOString?.() || null,
      });
    }
    nextToken = result?.NextToken;
  } while (nextToken);
  return out;
}
