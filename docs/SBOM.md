# Software Bill of Materials (SBOM)

## What is an SBOM?

A Software Bill of Materials (SBOM) is a machine-readable inventory of all software dependencies — direct and transitive — included in a release artifact. It enumerates every package, version, license, and (where available) supplier and cryptographic hash, so downstream consumers can answer questions like "is this build affected by CVE-XYZ?" or "does this release include any GPL-licensed code?" without rebuilding from source.

SiskelBot publishes SBOMs in two industry-standard formats:

- **CycloneDX** (`sbom.cyclonedx.json`) — the OWASP-maintained standard, consumed by most vulnerability scanners (Trivy, Grype, Snyk).
- **SPDX** (`sbom.spdx.json`) — the Linux Foundation / ISO/IEC 5962:2021 standard, often required by enterprise compliance frameworks.

## Why we generate SBOMs

1. **Vulnerability scanning** — pin a release to its exact dependency graph and re-scan it later when new CVEs are disclosed (no need to rebuild).
2. **License compliance** — produce a complete license inventory for legal review and OSS attribution notices.
3. **Supply chain transparency** — give downstream operators visibility into what they are actually deploying, including transitive dependencies.
4. **Regulatory requirements** — SBOMs are mandated or strongly recommended by:
   - **US Executive Order 14028** ("Improving the Nation's Cybersecurity") for software sold to the federal government.
   - **EU Cyber Resilience Act (CRA)** for products with digital elements sold in the EU.
   - **NIST SSDF** (Secure Software Development Framework) and **NTIA minimum elements** guidelines.

## Where to find SiskelBot's SBOMs

### Released SBOMs (production artifacts)

Every tagged release attaches both SBOM formats to the corresponding GitHub Release. Look for these files in the **Assets** section of any release at <https://github.com/hondoentertainment/SiskelBot/releases>:

- `sbom.cyclonedx.json` — CycloneDX format
- `sbom.spdx.json` — SPDX format

These are generated against the published Docker image (`ghcr.io/hondoentertainment/siskelbot:<version>`), so they reflect the exact contents of the released container — Node.js dependencies, OS packages, and image layers.

### Pull-request SBOMs (early-warning view)

When a PR touches `package.json`, `package-lock.json`, or `Dockerfile`, the `SBOM` workflow runs and generates a source-tree SBOM. Download it from the workflow run's **Artifacts** section as `sbom-source` (CycloneDX format, retained for 30 days). This lets reviewers see the dependency-graph delta of a PR before merging.

## How to consume an SBOM

### Vulnerability scan a released SBOM

```bash
# Download the SBOM for a specific release
gh release download v1.0.0 -p 'sbom.cyclonedx.json' -R hondoentertainment/SiskelBot

# Scan with Grype (consumes CycloneDX directly)
grype sbom:./sbom.cyclonedx.json

# Or with Trivy
trivy sbom ./sbom.cyclonedx.json
```

### License inventory

```bash
# Render the SBOM as a human-readable component table
syft sbom:./sbom.cyclonedx.json -o table

# Or extract licenses as JSON
jq '.components[] | {name, version, licenses}' sbom.cyclonedx.json
```

### Track a CVE across releases

```bash
for tag in $(gh release list -R hondoentertainment/SiskelBot --limit 10 --json tagName -q '.[].tagName'); do
  gh release download "$tag" -p 'sbom.cyclonedx.json' -O "sbom-$tag.json" -R hondoentertainment/SiskelBot
  echo "=== $tag ==="
  grype "sbom:./sbom-$tag.json" --only-fixed
done
```

## Tooling

SBOM generation is performed by [`anchore/sbom-action`](https://github.com/anchore/sbom-action), which wraps [Syft](https://github.com/anchore/syft) — the de facto open-source SBOM generator. We chose it because:

- Native support for both CycloneDX and SPDX (no format conversion step).
- Reads npm (`package-lock.json`), filesystem, and Docker image layers in a single tool.
- Self-hosted (no API rate limits or external service dependency).
- Actively maintained by Anchore with frequent releases.

## Refresh policy

SBOMs are regenerated automatically:

- **On every release tag** (`v*`) — both CycloneDX and SPDX, against the pushed Docker image, attached to the GitHub Release. See `.github/workflows/release.yml`.
- **On every PR that touches `package.json`, `package-lock.json`, or `Dockerfile`** — CycloneDX source SBOM, uploaded as a workflow artifact retained for 30 days. See `.github/workflows/sbom.yml`.

If a CVE is disclosed for a dependency in a released SBOM, no regeneration is needed — re-scan the existing SBOM with an updated vulnerability database (Grype/Trivy refresh their feeds independently).
