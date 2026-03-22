# Phase 35: Docker & Container Support

Self-host SiskelBot in Docker. Uses Node.js 20 Alpine, runs as non-root, and includes a liveness health check. Vercel deployment is unchanged; Docker is for self-hosted deployments.

## Quick start

### Build and run (Compose)

```bash
# Build and start SiskelBot + Ollama
docker compose up -d

# View logs
docker compose logs -f siskelbot
```

App: `http://localhost:3000`. Ollama: `http://localhost:11434`.

### Build and run (standalone)

```bash
# Build
docker build -t siskelbot .

# Run (use external Ollama or OpenAI; set env as needed)
docker run -d -p 3000:3000 \
  -e BACKEND=ollama \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  --name siskelbot siskelbot

# Or with OpenAI
docker run -d -p 3000:3000 \
  -e BACKEND=openai \
  -e OPENAI_API_KEY=sk-... \
  -v siskelbot-data:/app/data \
  --name siskelbot siskelbot
```

## Dockerfile

- **Base:** `node:20-alpine`
- **Build:** Multi-stage; `npm ci --omit=dev` for production deps only
- **User:** Non-root `appuser` (uid 1000)
- **Port:** 3000 (override via `PORT`)
- **Health check:** `GET /health/live` every 30s (curl)
- **CMD:** `node server.js`

## .dockerignore

Excluded from the image: `node_modules`, `.git`, `.env`, `data/`, `backups/`, `*.log`, `.vercel`, `tests/`, `docs/` — keeps the image smaller.

## docker-compose.yml

| Service    | Description                                      |
|-----------|---------------------------------------------------|
| `siskelbot` | SiskelBot app (builds from `Dockerfile`)         |
| `ollama`    | Optional local Ollama for dev/self-hosted       |

**Environment (compose):**
- `BACKEND=ollama`
- `OLLAMA_URL=http://ollama:11434`
- `PORT=3000`

**Volumes:**
- `siskelbot-data:/app/data` — persisted app data
- `ollama-data:/root/.ollama` — Ollama models

### Compose variants

**SiskelBot only** (external Ollama or OpenAI):
```bash
docker compose up -d siskelbot
```

Set `BACKEND` and `OLLAMA_URL` or `OPENAI_API_KEY` in your environment or a `.env` file.

**With local Ollama:**
```bash
docker compose up -d
```

Then: `ollama pull llama3.2` on the host, or exec into the ollama container.

**OpenAI backend (no Ollama):**
```bash
BACKEND=openai OPENAI_API_KEY=sk-... docker compose up -d siskelbot
```

Or create a `.env` file with these variables.

## docker-compose.override.yml.example (local Ollama)

Copy to `docker-compose.override.yml` for local development with Ollama:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
```

Then `docker compose up` merges the override automatically. See the example file for details.

## Host data (bind mount)

To persist data on the host instead of a named volume:

```yaml
volumes:
  - ./data:/app/data
```

Ensure `./data` exists and is writable by uid 1000 (or `chown 1000:1000 data` on Linux).

## Health check

The image includes:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health/live || exit 1
```

For orchestrators (e.g. Kubernetes), use `GET /health/live` (liveness) and `GET /health/ready` (readiness).

## Makefile (optional)

If a `Makefile` is present:

```bash
make docker-build   # Build image
make docker-run    # Run with docker compose up -d
```
