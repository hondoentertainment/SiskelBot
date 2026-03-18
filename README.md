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

## Production (Vercel)

For Vercel deployment, Ollama and vLLM (localhost) will not work. Use the OpenAI backend and secure the API:

1. Connect your GitHub repo at [vercel.com](https://vercel.com) → Add New Project.
2. Vercel uses `vercel.json` for build/routes. In **Project → Settings → Environment Variables**, add (for Production):
   - `BACKEND` = `openai` (required; Ollama localhost won't work)
   - `OPENAI_API_KEY` = your OpenAI API key (required)
   - `API_KEY` = a secret key to protect `/v1/chat/completions` (strongly recommended)
3. Redeploy after adding variables.

See [Vercel environment variables documentation](https://vercel.com/docs/projects/environment-variables) for details.

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

### 3. Deploy to Vercel

1. Connect your GitHub repo at [vercel.com](https://vercel.com) → Add New Project.
2. Vercel uses the `vercel.json` config (builds, routes, functions).
3. Set env vars per [Production (Vercel)](#production-vercel) above.

## Custom domain (Vercel)

Custom domains are configured in the Vercel dashboard, not in `vercel.json`. For a full deployment and custom domain guide, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Quick steps:

### Add a custom domain

1. Open [Vercel Dashboard](https://vercel.com/dashboard) → select your project (SiskelBot).
2. Go to **Settings** → **Domains**.
3. Enter your domain (e.g. `assistant.yourdomain.com` or `yourdomain.com`) and click **Add**.
4. Vercel will show the DNS records you need to create.

### DNS setup

**Subdomain (e.g. `assistant.yourdomain.com`):**

| Type  | Name     | Value                     |
|-------|----------|---------------------------|
| CNAME | assistant | `cname.vercel-dns.com`     |

**Apex domain (e.g. `yourdomain.com`):**

| Type | Name | Value           |
|------|------|-----------------|
| A    | @    | `76.76.21.21`   |

Use your registrar’s DNS management to add the records. Exact names may vary; follow the values Vercel shows for your project.

### SSL (HTTPS)

After DNS propagates (often within minutes, sometimes up to 48 hours), Vercel automatically provisions a TLS certificate. HTTPS will be enabled with no extra steps.

### Verify

- In Vercel → Domains, confirm the domain shows a green “Valid configuration” status.
- Optional: `vercel alias set <deployment-url> <your-domain>` via the Vercel CLI for programmatic aliasing.

## Project layout

```
experimentagent/
├── server.js           # Express streaming proxy
├── vercel.json         # Vercel deploy config (builds, functions, routes; env vars in Dashboard)
├── docs/
│   └── DEPLOYMENT.md   # Vercel deployment and custom domain setup
├── client/
│   └── index.html      # Chat UI
├── .github/workflows/
│   └── ci.yml          # CI on push
├── render.yaml         # Render deploy config
├── package.json
└── .env.example
```
