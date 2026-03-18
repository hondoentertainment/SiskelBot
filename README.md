# Experiment Agent

Realtime streaming assistant proxy for Ollama, vLLM, or OpenAI. Node.js proxy that streams chat completions to clients.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Choose a backend

**Ollama (recommended on Windows):**

```bash
# Install from https://ollama.ai, then:
ollama pull llama3.2
```

**vLLM (Linux/WSL):**

```bash
pip install vllm
vllm serve meta-llama/Llama-3-8B-Instruct --max-model-len 4096
```

### 3. Start the proxy

```bash
# For Ollama (default for quick start)
set BACKEND=ollama
npm start

# Or copy .env.example to .env and set BACKEND=ollama
```

Runs on `http://localhost:3000`.

### 4. Use the app

- Open `http://localhost:3000` in a browser
- API: `POST http://localhost:3000/v1/chat/completions` (OpenAI-compatible)

## Backends

| Backend | Env vars | Notes |
|---------|----------|-------|
| **Ollama** | `BACKEND=ollama`, `OLLAMA_URL` | Local, Windows-friendly |
| **vLLM** | `BACKEND=vllm`, `VLLM_URL` | High throughput, Linux/WSL |
| **OpenAI** | `BACKEND=openai`, `OPENAI_API_KEY` | Cloud API |

## Environment

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND` | `vllm` | `ollama`, `vllm`, or `openai` |
| `VLLM_URL` | `http://localhost:8000` | vLLM server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OPENAI_API_KEY` | — | Required for OpenAI backend |
| `PORT` | `3000` | Proxy port |
| `API_KEY` | — | Optional; protects /v1/chat/completions |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `60` | Max requests per window per IP |

## Deploy to GitHub

### 1. Create repo and push

```bash
git init
git add .
git commit -m "feat: streaming assistant with multi-backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/experimentagent.git
git push -u origin main
```

### 2. Deploy to Render (optional)

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env vars (e.g. `BACKEND=openai`, `OPENAI_API_KEY=...`)

Or use the included `render.yaml` for one-click deploy.

**Note:** The proxy needs a backend (Ollama, vLLM, or OpenAI). For cloud deploy, use `BACKEND=openai` with an API key. Ollama/vLLM require a separate server.

## Project layout

```
experimentagent/
├── server.js           # Express streaming proxy
├── client/
│   └── index.html      # Chat UI
├── .github/workflows/
│   └── ci.yml          # CI on push
├── render.yaml         # Render deploy config
├── package.json
└── .env.example
```
