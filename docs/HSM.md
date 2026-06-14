# HSM (Hardware Security Module) Integration

SiskelBot supports multiple HSM providers for high-security key management. All providers implement a unified interface for generating, signing, verifying, encrypting, and decrypting with cryptographic keys.

## Supported Providers

| Provider | Use Case | Dependencies |
|----------|----------|-------------|
| `software` | Development, testing, low-security | None (pure Node.js crypto) |
| `aws-kms` | AWS deployments | `@aws-sdk/client-kms` (in project deps) |
| `gcp-kms` | Google Cloud deployments | None (REST API via fetch) |
| `azure-keyvault` | Azure deployments | None (REST API via fetch) |
| `pkcs11` | On-prem HSMs (Thales, Utimaco, YubiHSM) | `pkcs11js` + vendor native library |

## Configuration

Set the `HSM_PROVIDER` environment variable to select a provider:

```bash
# Software (default)
HSM_PROVIDER=software

# AWS KMS
HSM_PROVIDER=aws-kms
AWS_REGION=us-east-1
# AWS credentials via standard env/IAM

# GCP KMS
HSM_PROVIDER=gcp-kms
GCP_PROJECT_ID=my-project
GCP_ACCESS_TOKEN=...  # Or use google-auth-library in production

# Azure Key Vault
HSM_PROVIDER=azure-keyvault
AZURE_KEY_VAULT_NAME=my-vault
AZURE_ACCESS_TOKEN=...  # Or use @azure/identity in production

# PKCS#11 (requires vendor library)
HSM_PROVIDER=pkcs11
PKCS11_MODULE_PATH=/usr/lib/libsofthsm2.so
```

## API Usage

```js
import { getGlobalHSM, createHSMClient } from "./lib/hsm.js";

// Use the globally configured HSM
const hsm = getGlobalHSM();

// Or create explicitly
const hsm = createHSMClient("aws-kms", { region: "us-east-1" });

// Generate a key
const { keyId } = await hsm.generateKey("my-signing-key", "rsa-2048");

// Sign data
const signature = await hsm.sign("my-signing-key", "data to sign");

// Verify
const valid = await hsm.verify("my-signing-key", "data to sign", signature);

// Encrypt with symmetric key
await hsm.generateKey("data-key", "aes-256");
const encrypted = await hsm.encrypt("data-key", "secret data");
const decrypted = await hsm.decrypt("data-key", encrypted);

// List and manage keys
const keys = await hsm.listKeys();
const metadata = await hsm.getKeyMetadata("my-signing-key");
await hsm.deleteKey("my-signing-key");

// Key wrapping (software provider only)
const wrapped = await hsm.wrapKey("kek", "dek");
await hsm.unwrapKey("kek", wrapped);
```

## Supported Key Types

| Key Type | Symmetric/Asymmetric | Use |
|----------|---------------------|-----|
| `aes-256` / `aes-256-gcm` | Symmetric | Encrypt/decrypt |
| `rsa-2048` / `rsa` | Asymmetric | Sign/verify, encrypt/decrypt (RSA-OAEP) |
| `ec` / `ecdsa-p256` | Asymmetric | Sign/verify (ECDSA P-256) |

## Admin API

All HSM endpoints require admin authentication.

```
GET /api/v1/hsm/status
POST /api/v1/hsm/keys         { keyId, keyType }
GET /api/v1/hsm/keys/:keyId
DELETE /api/v1/hsm/keys/:keyId
```

## Provider-Specific Notes

### AWS KMS
- Uses `@aws-sdk/client-kms` (already in project dependencies).
- Requires AWS credentials via environment, IAM role, or profile.
- Keys are scheduled for deletion (7-day pending window) rather than immediately removed.
- Supports envelope encryption for large data.

### GCP KMS
- Uses REST API directly (no SDK dependency).
- Requires an access token; in production use `google-auth-library` to refresh tokens automatically.
- Configure key ring via `GCP_KMS_KEY_RING` (default: `siskelbot`).
- Location is set via `GCP_KMS_LOCATION` (default: `global`).

### Azure Key Vault
- Uses REST API directly.
- Requires an access token; in production use `@azure/identity` for managed identity or service principal.
- Key Vault must be created in advance.
- RSA-OAEP-256 is used for encryption, RS256 for signing.

### PKCS#11
- Requires `pkcs11js` npm package and a vendor-specific native library.
- Common HSMs: Thales nShield, Utimaco CryptoServer, YubiHSM, SoftHSM.
- This is a stub implementation; full support requires vendor-specific adaptation.

## Security Considerations

- The `software` provider stores keys in-process memory and is **not suitable for production** without additional at-rest encryption.
- When using cloud HSMs, ensure IAM policies restrict access to the minimum required operations.
- Rotate keys periodically using the `lib/secret-rotation-auto.js` module.
- Wrap and back up master keys securely.
- Audit HSM operations via the standard audit log.

## Testing

Run the HSM test suite:

```bash
node --test tests/hsm.test.js
```

The tests use the software provider with real Node.js crypto operations, so they validate end-to-end key generation, signing, verification, encryption, and decryption.
