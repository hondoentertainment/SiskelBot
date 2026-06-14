# Air-gapped deployment guide

This guide explains how to build, transfer, install, and maintain SiskelBot in environments with no inbound or outbound internet access.

## Use cases

Air-gapped deployments are common in:

- **Government and defense** - classified networks, SCIFs, intelligence enclaves
- **Finance** - trading floors, compliance-gated networks, card processing environments
- **Healthcare** - PHI-handling systems under HIPAA data segregation rules
- **Critical infrastructure** - SCADA, utility grid management, OT networks
- **Research** - labs handling export-controlled or proprietary datasets
- **Regulated industries** - pharma, energy, legal discovery environments

The common thread is that the target hosts cannot reach `npmjs.org`, `registry-1.docker.io`, model registries, or OAuth providers. Everything must arrive as a single audited artifact.

## Architecture

```
+---------------------+                    +----------------------+
| Build host          |                    | Air-gapped target    |
| (internet access)   |                    | (no internet)        |
|                     |                    |                      |
|  git clone          |                    |  sudo ./install.sh   |
|  build-bundle.sh    | ---> USB / diode ->|  systemctl start     |
|  sign with GPG      |                    |  journalctl -f       |
+---------------------+                    +----------------------+
```

The build host does all the work that needs internet: pulling source, resolving npm dependencies, saving Docker images, and pulling Ollama blobs. The air-gapped target only installs what arrives.

## Build host requirements

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 18+ | `npm ci --omit=dev` |
| npm | 9+ | Dependency resolution |
| git | 2.0+ | `git archive` for source |
| tar / gzip | any | Bundle creation |
| sha256sum | any | Integrity manifest |
| Docker | optional | `--with-docker` to bundle images |
| Ollama | optional | `--with-ollama` to bundle model blobs |
| GPG | optional | Bundle signing |

Ideally the build host matches the target OS and CPU architecture (for example, both `linux/amd64`). Native npm modules are architecture-specific.

## Security considerations

### Network isolation

The `.env.template` shipped in `templates/offline.env` defaults to:

- `BACKEND=ollama` with `OLLAMA_URL=http://ollama.internal:11434`
- No `SEARCH_API`, no `PLUGIN_REGISTRY_URL`
- No OAuth client IDs
- No Slack or Discord tokens
- `DISABLE_TELEMETRY=1`
- `AGENT_CODE_EXECUTE=0`
- `AGENT_DB_QUERY=0`

The only outbound traffic SiskelBot should generate in this configuration is to internal LLM backends, the local database (if Postgres), and the local Redis (if configured). Verify this with a host firewall or network egress policy after installation.

### Supply chain integrity

Every bundle ships with three integrity artifacts:

1. `MANIFEST.sha256` inside the bundle - per-file SHA256, checked at extract time and by `install.sh`
2. `<bundle>.tar.gz.sha256` next to the bundle - top-level SHA256 for transport validation
3. `<bundle>.tar.gz.asc` next to the bundle - detached GPG signature (if the build host has a secret key)

The recommended chain of custody:

1. Build host signs with an offline hardware-protected key (YubiKey, smart card)
2. Transfer tarball + `.sha256` + `.asc` to a transfer medium
3. Verify top-level hash against a hash communicated out of band
4. Verify GPG signature against a pre-imported public key on the target
5. Run `verify-bundle.sh` to check per-file integrity
6. Only then run `install.sh`

### Service hardening

`templates/systemd.service` enables `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, a restrictive `SystemCallFilter`, and empty `CapabilityBoundingSet`. The `siskelbot` user is a system account with no login shell (`/bin/false`).

Only `INSTALL_DIR/data` is writable. If you enable workspace file tools (`WORKSPACE_FILE_TOOLS=1`), add the workspace root to `ReadWritePaths` in the systemd unit.

## Transfer methods

| Method | Notes |
|--------|-------|
| **USB drive** | Most common. Use write-once media where possible. Verify checksums on both sides. |
| **Data diode** | One-way optical or hardware-enforced transfer for high-assurance networks. Bundle must be self-contained. |
| **Internal artifact repository** | Nexus, Artifactory, or a private S3-compatible store accessible from both sides of the air gap via manual staging. |
| **Secure file transfer** | Cross-domain solutions (CDS) for classified environments. |
| **Physical courier** | For extreme isolation, sneakernet with chain-of-custody forms. |

In all cases, transfer the checksum and signature *separately* from the bundle, or communicate the expected hash through a different channel than the bundle itself.

## Build procedure

On the build host:

```bash
git clone https://github.com/your-org/siskelbot.git
cd siskelbot
git checkout v1.2.3   # pin to a release tag

# Base bundle (source + node_modules)
./deploy/airgap/build-bundle.sh

# With Docker images bundled
./deploy/airgap/build-bundle.sh --with-docker

# With Ollama model blobs bundled
./deploy/airgap/build-bundle.sh --with-ollama llama3:8b
```

Output files appear in the current directory:

```
siskelbot-airgap-1.2.3.tar.gz
siskelbot-airgap-1.2.3.tar.gz.sha256
siskelbot-airgap-1.2.3.tar.gz.asc     # if GPG is configured
```

## Installation procedure

On the target host:

```bash
# 1. Verify the bundle
./verify-bundle.sh siskelbot-airgap-1.2.3.tar.gz

# 2. Extract
tar -xzf siskelbot-airgap-1.2.3.tar.gz
cd siskelbot-airgap-1.2.3

# 3. Install (default dir: /opt/siskelbot)
sudo ./install.sh

# 4. Configure
sudo -u siskelbot $EDITOR /opt/siskelbot/.env

# 5. Start
sudo systemctl start siskelbot
sudo systemctl status siskelbot
sudo journalctl -u siskelbot -f
```

To install to a custom directory:

```bash
sudo ./install.sh /srv/siskelbot
```

## Update strategy

SiskelBot updates in air-gapped environments follow the same build-verify-deploy flow:

1. **Build a new bundle** on the build host from the new release tag
2. **Stop the running service** on the target: `sudo systemctl stop siskelbot`
3. **Back up the existing install**: `sudo tar -czf /var/backups/siskelbot-$(date +%F).tar.gz -C /opt siskelbot`
4. **Verify the new bundle**: `./verify-bundle.sh siskelbot-airgap-1.2.4.tar.gz`
5. **Extract and reinstall**: The installer preserves `.env` and `data/` because it only overwrites code files
6. **Run migrations**: `sudo -u siskelbot node /opt/siskelbot/bin/siskelbot.js migrate`
7. **Restart**: `sudo systemctl start siskelbot`
8. **Verify**: `curl -s http://localhost:3000/health`

Keep at least the previous two bundles on disk so you can roll back instantly if a release misbehaves.

## Offline model management

Air-gapped sites cannot pull models from `ollama.com` or Hugging Face. Bundle models with the build host.

### Option A: bundle with `--with-ollama`

```bash
# On the build host
ollama pull llama3:8b
./deploy/airgap/build-bundle.sh --with-ollama llama3:8b
```

The installer copies model blobs into `/usr/share/ollama/.ollama/models` (or whatever `OLLAMA_MODELS` points to).

### Option B: separate model archive

For large models, build a separate archive that can be transferred independently:

```bash
# On the build host
tar -czf ollama-models-llama3-8b.tar.gz -C ~/.ollama models

# On the target
sudo systemctl stop ollama
sudo tar -xzf ollama-models-llama3-8b.tar.gz -C /usr/share/ollama/.ollama/
sudo chown -R ollama:ollama /usr/share/ollama/.ollama
sudo systemctl start ollama
```

### Option C: pre-baked VM image

For large fleets, pre-bake a VM or container image with Ollama and a pinned model set. Deploy the image through your normal air-gapped provisioning flow, then layer SiskelBot on top with `install.sh`.

## Compliance notes

### Audit logging

SiskelBot's audit log (`lib/audit-lifecycle.js`, `lib/audit-query.js`) captures every authenticated request and agent action. For compliance evidence:

- Enable audit log S3 archival with an **internal** S3-compatible endpoint (e.g., MinIO): set `AUDIT_S3_ENDPOINT`, `AUDIT_S3_BUCKET`, `AUDIT_S3_REGION`
- Set `AUDIT_RETENTION_DAYS` to satisfy your retention policy (typical values: 90, 365, 2555)
- Periodically export the audit log via `siskelbot admin audit export`

### No telemetry

Air-gapped builds set `DISABLE_TELEMETRY=1`. SiskelBot has no background analytics, error reporting, or update-check beacons. Verify with a host firewall rule and by inspecting `lib/error-reporting.js` if you need to certify outbound traffic.

### Data sovereignty

All user data, conversations, knowledge-base documents, and embeddings stay on the target host (JSON files in `STORAGE_PATH`, or your internal Postgres). No data is uploaded to external model providers because `BACKEND=ollama` or `BACKEND=vllm` keeps inference on-prem.

### FIPS compliance

If your environment requires FIPS 140-2/3 cryptographic modules, ensure your Node.js build links against a FIPS-certified OpenSSL. The bundle itself is format-agnostic; the compliance properties come from the runtime you install.

### Change management

Every bundle is a single immutable artifact with a SHA256 and GPG signature. Attach the checksum and signature to your change ticket and record the transfer chain of custody. Use `verify-bundle.sh` output as evidence that the installed bytes match what the change ticket approved.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `INTEGRITY CHECK FAILED` during install | Bundle corrupted in transit | Re-transfer bundle, re-verify top-level SHA256 before extracting |
| `npm ci` failed during `build-bundle.sh` | Build host missing internet or lockfile mismatch | Run on a host with registry access, ensure `package-lock.json` is committed |
| Service starts then crashes | `.env` still contains `CHANGE_ME_` placeholders | Edit `/opt/siskelbot/.env` and set `API_KEY`, `ADMIN_API_KEY`, `SESSION_SECRET` |
| `systemctl start siskelbot` fails with EACCES | Data dir not writable | `sudo chown -R siskelbot:siskelbot /opt/siskelbot/data` |
| LLM requests fail with `ECONNREFUSED` | Ollama or vLLM not reachable | Check `OLLAMA_URL` / `VLLM_URL` and internal DNS |
| Ollama model not found | Blobs not copied to correct path | Check `OLLAMA_MODELS` env var and `/usr/share/ollama/.ollama/models` |

## See also

- `docs/RUNBOOK.md` - day-two operations
- `docs/DEPLOYMENT.md` - general deployment guide
- `docs/MULTI_REGION_HA.md` - multi-node and HA setup
- `deploy/airgap/README.md` - quick start
