# Container Image Signing

SiskelBot signs every released container image using [Sigstore](https://sigstore.dev/)
cosign with keyless OIDC. This document explains why we sign, how the signing
works, what gets signed, and how to verify a signature.

## Why we sign

- **Provenance**: prove that an image with a given digest was produced by our
  GitHub Actions release pipeline, not by an attacker who breached a registry
  account or smuggled an image into a mirror.
- **Tamper-evidence**: any modification to the image bytes invalidates the
  signature. Pulling an unsigned or wrongly-signed image is detectable at
  deploy time.
- **Compliance**: signed images are required for [SLSA Level 3](https://slsa.dev/spec/v1.0/levels#build-l3)
  and frequently required by enterprise / regulated customers (FedRAMP,
  PCI-DSS supply-chain controls, internal "no unsigned containers" policies).
- **No key rotation burden**: keyless signing eliminates the cost of managing,
  rotating, and revoking long-lived signing keys.

## How it works (keyless OIDC)

```
GitHub Actions runner
        |
        | (1) requests OIDC token from GitHub
        v
GitHub OIDC provider (token.actions.githubusercontent.com)
        |
        | (2) signed JWT with workflow identity
        v
cosign --yes
        |
        | (3) exchanges JWT for short-lived (10 min) X.509 cert
        v
Fulcio (Sigstore CA)
        |
        | (4) signs image digest with ephemeral private key
        v
Rekor (public transparency log)
        |
        | (5) signature + cert appended to immutable Merkle log
        v
OCI registry (ghcr.io)
        |
        '-- signature stored as sha256-<digest>.sig tag alongside image
```

There are no long-lived private keys anywhere in this flow. The ephemeral key
used to sign the image lives only in memory on the runner and is destroyed
when the job ends. Verifiers reconstruct trust from:

- The Fulcio root CA (well-known, hard-coded into cosign)
- The Rekor transparency log (public, append-only, witnessed)
- The certificate's embedded claim about which workflow / repository / ref
  produced it

## What gets signed

Each release publishes three Sigstore artifacts to `ghcr.io`:

| Artifact | Mechanism | Stored as |
|---|---|---|
| Container image | `cosign sign` | `sha256-<digest>.sig` tag |
| CycloneDX SBOM | `cosign attest --type cyclonedx` | `sha256-<digest>.att` tag |
| Build provenance (SLSA) | `actions/attest-build-provenance` | OCI referrer on the image |

The image signature proves the image is authentic. The SBOM attestation binds
the SBOM to the image digest cryptographically — you cannot swap in a different
SBOM after the fact. The provenance attestation records the workflow run that
built the image (commit SHA, builder identity, materials).

## How users verify

### Manual verification with cosign

```bash
# Verify the image signature
cosign verify \
  --certificate-identity-regexp 'https://github.com/hondoentertainment/SiskelBot/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/hondoentertainment/siskelbot:v1.0.0

# Verify the SBOM attestation and print the embedded CycloneDX document
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp 'https://github.com/hondoentertainment/SiskelBot/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/hondoentertainment/siskelbot:v1.0.0
```

The `--certificate-identity-regexp` pin ensures the signature came from a
workflow in our repository. The `--certificate-oidc-issuer` pin ensures it was
GitHub Actions (not, say, a developer laptop using a personal Google identity).
Both are required — if either is omitted, the verification accepts any
Sigstore-signed image.

### Via the verification workflow

For convenience, repository maintainers can run the verification workflow:

```bash
gh workflow run verify-signature.yml -f tag=v1.0.0
```

This invokes `cosign verify` with the correct identity / issuer pins on a
GitHub-hosted runner.

## Kubernetes admission control

To enforce "only signed images may run" cluster-wide, install a Sigstore-aware
admission controller. Two common options:

- [**sigstore/policy-controller**](https://docs.sigstore.dev/policy-controller/overview/)
  — Sigstore project, native cosign verification.
- [**Kyverno**](https://kyverno.io/policies/?policytypes=Cosign) — general
  policy engine with first-class `verifyImages` support.

Example Kyverno policy that requires every image in the `siskelbot` namespace
to be signed by our release workflow:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-siskelbot-signed-images
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-siskelbot
      match:
        any:
          - resources:
              namespaces: ["siskelbot"]
              kinds: ["Pod"]
      verifyImages:
        - imageReferences:
            - "ghcr.io/hondoentertainment/siskelbot:*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/hondoentertainment/SiskelBot/.*"
                    issuer: "https://token.actions.githubusercontent.com"
```

With this policy in place, any attempt to schedule a Pod referencing an
unsigned (or wrongly-signed) SiskelBot image is rejected by the API server.
