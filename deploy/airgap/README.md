# SiskelBot air-gapped deployment

Build, verify, and install SiskelBot on machines with no internet access.

For the full guide see [`docs/AIRGAPPED_DEPLOYMENT.md`](docs/AIRGAPPED_DEPLOYMENT.md).

## Quick start

### 1. Build a bundle (on a build host with internet)

```bash
# From the SiskelBot repository root
./deploy/airgap/build-bundle.sh
```

This produces:

- `siskelbot-airgap-<version>.tar.gz` - the bundle
- `siskelbot-airgap-<version>.tar.gz.sha256` - top-level checksum
- `siskelbot-airgap-<version>.tar.gz.asc` - GPG signature (if a secret key is configured)

Options:

| Flag | Purpose |
|------|---------|
| `--with-docker` | Bundle `postgres:16-alpine`, `redis:7-alpine`, `ollama/ollama:latest` as loadable `.tar` files |
| `--with-ollama <model>` | Bundle Ollama model blobs from `~/.ollama/models` |

### 2. Transfer to the air-gapped target

Use a USB drive, one-way diode, or internal artifact repository. Transfer all three files together: the tarball, the `.sha256`, and (if signed) the `.asc`.

### 3. Verify the bundle

```bash
./deploy/airgap/verify-bundle.sh siskelbot-airgap-1.2.3.tar.gz
```

This checks the top-level SHA256, the GPG signature (if present), and the per-file `MANIFEST.sha256` inside the bundle.

### 4. Extract and install

```bash
tar -xzf siskelbot-airgap-1.2.3.tar.gz
cd siskelbot-airgap-1.2.3
sudo ./install.sh
```

The installer will:

1. Verify `MANIFEST.sha256` again
2. Check prerequisites (Node 18+, npm, systemctl)
3. Create the `siskelbot` service user
4. Copy files to `/opt/siskelbot`
5. Create `.env` from `.env.template`
6. Load bundled Docker images (if any)
7. Copy bundled Ollama model blobs (if any)
8. Install and enable the `siskelbot` systemd service

### 5. Configure and start

```bash
sudo -u siskelbot $EDITOR /opt/siskelbot/.env
sudo systemctl start siskelbot
sudo systemctl status siskelbot
sudo journalctl -u siskelbot -f
```

Override the install directory by passing it to `install.sh`:

```bash
sudo ./install.sh /srv/siskelbot
```

## Files in this directory

| File | Purpose |
|------|---------|
| `build-bundle.sh` | Builds the offline bundle on a connected host |
| `install.sh` | Runs on the air-gapped target to install the service |
| `verify-bundle.sh` | Verifies a bundle without installing |
| `templates/offline.env` | `.env` template with only internal URLs |
| `templates/systemd.service` | Hardened systemd unit with placeholders |
| `docs/AIRGAPPED_DEPLOYMENT.md` | Full deployment guide |
