# SiskelBot Quick Start

Get up and running in 5 minutes.

## Prerequisites

- **Node.js 18+** ([download](https://nodejs.org/))
- **An LLM backend** -- one of:
  - [Ollama](https://ollama.com/) (recommended, free, local)
  - [vLLM](https://docs.vllm.ai/) (self-hosted GPU inference)
  - [OpenAI API key](https://platform.openai.com/api-keys)

## 1. Install

```bash
git clone https://github.com/hondoentertainment/SiskelBot.git
cd SiskelBot
npm ci
```

## 2. Configure

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

The minimum configuration for a local Ollama setup requires no changes -- the defaults work out of the box:

```env
BACKEND=ollama
OLLAMA_URL=http://localhost:11434
PORT=3000
```

For **OpenAI**, set:

```env
BACKEND=openai
OPENAI_API_KEY=sk-your-key-here
```

For **vLLM**, set:

```env
BACKEND=vllm
VLLM_URL=http://localhost:8000
```

Optionally, protect your endpoints with an API key:

```env
API_KEY=my-secret-key
```

## 3. Start

```bash
npm start
```

You should see output like:

```
SiskelBot listening on http://localhost:3000
Backend: ollama (http://localhost:11434)
```

Open `http://localhost:3000` in a browser to access the chat UI. The admin dashboard is at `http://localhost:3000/admin.html`.

## 4. First Chat

Send a basic chat completion request:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "What is SiskelBot?" }
    ]
  }'
```

If you set an `API_KEY`, include it:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'
```

For **streaming**, set `"stream": true` -- the response arrives as Server-Sent Events:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Explain quantum computing briefly." }
    ],
    "stream": true
  }'
```

## 5. Add Knowledge

Add a document to the knowledge base so the agent can reference it:

```bash
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Company FAQ",
    "content": "SiskelBot is a realtime streaming assistant proxy. It supports Ollama, vLLM, and OpenAI backends."
  }'
```

Verify it was stored:

```bash
curl http://localhost:3000/api/v1/context
```

Search the knowledge base:

```bash
curl "http://localhost:3000/api/v1/knowledge/search?q=streaming&workspace=default"
```

## 6. Agent Mode

Agent mode enables the LLM to use tools -- searching knowledge, executing recipes, fetching URLs, and more. The agent loops until it produces a final answer.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Search our knowledge base for information about streaming and summarize it." }
    ],
    "agentMode": true,
    "agentOptions": {
      "workspace": "default",
      "maxIterations": 5
    }
  }'
```

The response includes tool call traces via SSE events, finishing with the agent's synthesized answer. The `X-Agent-Iteration` header tells you how many tool-call rounds the agent used.

## 7. Next Steps

| Topic | Resource |
|-------|----------|
| 20+ API recipes | [docs/API_COOKBOOK](/docs/API_COOKBOOK) |
| Architecture decisions | [docs/ARCHITECTURE](/docs/ARCHITECTURE) |
| CLI usage | `npx siskelbot --help` or `npm run cli -- --help` |
| Docker & Compose | [docs/DOCKER](/docs/DOCKER) |
| Docker Compose reference | [docs/DOCKER_COMPOSE](/docs/DOCKER_COMPOSE) |
| Deployment guide | [docs/DEPLOYMENT](/docs/DEPLOYMENT) |
| Desktop app (Electron) | [docs/DESKTOP](/docs/DESKTOP) |
| Plugin development | [docs/PLUGINS](/docs/PLUGINS) and [docs/PLUGIN_API](/docs/PLUGIN_API) |
| Webhooks | [docs/WEBHOOKS](/docs/WEBHOOKS) |
| Operational runbook | [docs/RUNBOOK](/docs/RUNBOOK) |
| Multi-region HA | [docs/MULTI_REGION_HA](/docs/MULTI_REGION_HA) |
| SDK guide | [docs/SDK_GUIDE](/docs/SDK_GUIDE) |
| VS Code extension | `vscode-extension/` directory |
| Full environment variable reference | `.env.example` |
