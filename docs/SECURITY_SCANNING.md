# Security Scanning

SiskelBot runs multiple complementary security scanners in CI. This document explains what each one does, how findings flow, and how to handle false positives.

## Three scan types in CI

| Scanner | What it scans | Where | Fails on |
|---|---|---|---|
| Trivy (image) | container layers, OS packages, app deps | `.github/workflows/docker.yml`, `.github/workflows/release.yml` | CRITICAL |
| Trivy (fs) | source files, lockfiles, IaC, secrets | `.github/workflows/ci.yml` | CRITICAL |
| CodeQL | source code (semantic) | `.github/workflows/codeql.yml` | (security alerts only, no fail) |
| Dependabot | direct deps in `package.json` | continuous, opens PRs | n/a |

### Why both image and filesystem scans?

The image scan covers what actually ships to production: the OS layer and the production `node_modules`. The filesystem scan catches things the image scan can't see:

- **Lockfile vulnerabilities for dev dependencies** — these don't ship in the image but they run during builds and tests, so a compromised dev dep can taint the build environment.
- **Misconfiguration in IaC files** — `Dockerfile`, Kubernetes manifests, Helm templates, GitHub workflows. Trivy's misconfig scanner flags insecure defaults (running as root, missing health checks, overly permissive RBAC, etc.).
- **Secrets accidentally committed** — Trivy's `secret` scanner runs by default in `fs` mode and catches AWS keys, API tokens, private keys, etc. that may have slipped past pre-commit hooks.

## How findings flow

1. CI runs `trivy fs` and uploads SARIF to GitHub.
2. Findings appear in **GitHub Security tab → Code scanning**.
3. Triage by severity:
   - **CRITICAL** — blocks the build (Trivy exits 1). Fix or suppress before merging.
   - **HIGH** — visible in the Security tab but does not fail CI. Address in a follow-up if not immediately fixable.
   - **MEDIUM/LOW** — not surfaced (we set `severity: CRITICAL,HIGH`).
4. Each finding shows: file, line, package version, fixed version (if any), and CVE link.

### Behaviour of `ignore-unfixed: true`

Both scans set `ignore-unfixed: true`. Trivy will not report CVEs that have no upstream fix yet — these are noise we can't act on. When the upstream package publishes a patched version, Dependabot opens a PR and the finding starts surfacing again automatically.

## Suppressing a false positive

If a CRITICAL finding is genuinely not exploitable in our context, add it to `.trivyignore` at the repo root:

```text
CVE-2025-XXXXX  # Reviewed 2025-04-15: only affects Windows builds; we ship Linux only. Review by 2025-07-15.
```

Rules:

1. **Every entry MUST have a justification comment.** No bare CVE IDs.
2. **Include a review date** in the comment (90 days out).
3. **Open an issue** linking to the CVE so the suppression is tracked.
4. **Prefer fixing over suppressing** — only suppress when the CVE is provably non-exploitable in our deployment model.

## Local pre-commit scan

To catch findings before pushing, run Trivy locally against the working tree:

```bash
docker run --rm -v "$PWD:/src" aquasec/trivy fs /src \
  --severity CRITICAL,HIGH \
  --skip-dirs node_modules
```

For a faster check that mirrors CI exactly (CRITICAL only, with `.trivyignore` honoured):

```bash
docker run --rm -v "$PWD:/src" aquasec/trivy fs /src \
  --severity CRITICAL \
  --ignore-unfixed \
  --skip-dirs node_modules,client/dist,coverage,.claude \
  --ignorefile /src/.trivyignore
```

If you have Trivy installed natively (`brew install trivy` / `apt install trivy`), drop the `docker run` wrapper and run `trivy fs .` directly.

## Quarterly review

Every 90 days, the security owner reviews `.trivyignore`:

1. For each entry, check whether the CVE has a fix available now.
2. If a fix is available, remove the entry and bump the dependency.
3. If the CVE is still unfixed, confirm the original justification still holds and update the review date.
4. If the justification no longer holds, remove the entry — the next CI run will fail and force the team to act.

A reminder is on the engineering calendar (`Security: Trivy ignore review`). The reviewer should attach the diff (or "no changes") to the corresponding tracking issue.

## Adding a new scanner

When adding a new scanner to CI:

1. Add a job to `.github/workflows/ci.yml` (or a dedicated workflow if it's slow).
2. Upload SARIF via `github/codeql-action/upload-sarif` so findings show up in the Security tab.
3. Use a two-step pattern: a non-failing scan that produces SARIF for visibility, plus a failing scan with a stricter severity threshold so CI gates the merge.
4. Update the table at the top of this file.
