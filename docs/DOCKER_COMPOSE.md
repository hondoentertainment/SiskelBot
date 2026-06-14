# Docker Compose Development Environment

Complete development environment with PostgreSQL, Redis, Ollama, Prometheus, and Grafana.

## Quick Start

```bash
docker compose up -d
```

Services will be available at:

- **SiskelBot:** http://localhost:3000
- **Grafana:** http://localhost:3001 (admin/admin)
- **Prometheus:** http://localhost:9090
- **Ollama:** http://localhost:11434

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| siskelbot | Built from Dockerfile | 3000 | Main application |
| postgres | postgres:16-alpine | 5432 | Storage backend |
| redis | redis:7-alpine | 6379 | Caching and pubsub |
| ollama | ollama/ollama:latest | 11434 | LLM inference |
| prometheus | prom/prometheus:latest | 9090 | Metrics collection |
| grafana | grafana/grafana:latest | 3001 | Metrics dashboards |

## Development Mode

Mount source code for hot-reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This bind-mounts the project directory into the container and runs `npm run dev` for file watching.

## Pull a Model

After starting the stack, pull a model into Ollama:

```bash
docker compose exec ollama ollama pull llama3.2
```

## Environment Variables

Override environment variables by creating a `.env` file in the project root. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND` | `ollama` | Backend provider (`ollama`, `vllm`, `openai`) |
| `STORAGE_BACKEND` | `postgres` | Storage backend (`json`, `sqlite`, `postgres`) |
| `SESSION_SECRET` | `dev-secret-change-in-production` | Session cookie secret |
| `API_KEY` | (none) | Protects `/v1/chat/completions` |
| `ADMIN_API_KEY` | (none) | Protects admin endpoints |

See `.env.example` for the full list.

## Volumes

| Volume | Purpose |
|--------|---------|
| `pgdata` | PostgreSQL data persistence |
| `ollama` | Downloaded model weights |
| `grafana` | Grafana configuration and state |

## Stopping

```bash
docker compose down
```

To also remove volumes (deletes all data):

```bash
docker compose down -v
```

## Health Checks

All critical services have health checks configured:

- **SiskelBot:** `GET /health/live` every 10s
- **PostgreSQL:** `pg_isready` every 5s
- **Redis:** `redis-cli ping` every 5s

SiskelBot waits for PostgreSQL and Redis to be healthy before starting.

## Using OpenAI Instead of Ollama

Set environment variables to switch backends:

```bash
BACKEND=openai OPENAI_API_KEY=sk-... docker compose up -d siskelbot postgres redis
```

The `ollama` service can be omitted when using an external backend.
