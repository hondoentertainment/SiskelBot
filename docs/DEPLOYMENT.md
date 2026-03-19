# Deployment Guide (SiskelBot)

This guide covers deploying the SiskelBot streaming assistant to Vercel and configuring a custom domain.

## Vercel Deployment

1. Connect your GitHub repo at [vercel.com](https://vercel.com) → **Add New Project**
2. Vercel will detect the Node.js app and use the `vercel.json` config
3. In **Project → Settings → Environment Variables**, add (for Production):
   - `BACKEND` = `openai`
   - `OPENAI_API_KEY` = your OpenAI API key
   - `API_KEY` = a secret key to protect `/v1/chat/completions` (clients send `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`)
4. Redeploy after adding variables

> **Note:** Ollama and vLLM (localhost) do not work on Vercel. Use the OpenAI backend with an API key for production.

See [Vercel environment variables](https://vercel.com/docs/projects/environment-variables) for details.

---

## Persistent Backend Storage (Phase 10)

Context documents, recipes, and conversations can be stored in JSON files on the server. Set `STORAGE_PATH` (absolute or relative path) to the directory that will hold `context.json`, `recipes.json`, and `conversations.json`. If unset, the default is `data/` in the project root.

| Variable     | Default  | Description                                      |
|--------------|----------|--------------------------------------------------|
| `STORAGE_PATH` | `./data` | Directory for context, recipes, conversations JSON files |

> **Note:** On Vercel serverless, the filesystem is ephemeral. For production persistence, use a database or external storage. The JSON file backend is suitable for local or single-instance deployments (e.g. Render, Railway).

---

## Phase 16: Scheduled Recipes & Vercel Cron

`vercel.json` includes a cron job that hits `GET /api/cron` every minute to run due scheduled recipes. For this to work:

1. Set `ALLOW_RECIPE_STEP_EXECUTION=1` (scheduled runs execute steps).
2. Set `CRON_SECRET` in Vercel env vars. Vercel Cron sends requests with `Authorization: Bearer <CRON_SECRET>`. If unset, the route returns 401.
3. Add schedules via the client (Recipes → Schedule) or `POST /api/schedules`.

**Local vs Vercel:**

- **Local:** Set `ENABLE_SCHEDULED_RECIPES=1` to use in-process `node-cron`. No separate worker.
- **Vercel:** Use `vercel.json` crons; no in-process scheduler. `GET /api/cron` runs due jobs when invoked by Vercel Cron.

---

## Custom Domain Setup

Custom domains are configured in the Vercel dashboard, not in `vercel.json`. Use the steps below to add a custom domain to your SiskelBot deployment.

### Add a custom domain

1. Open [Vercel Dashboard](https://vercel.com/dashboard) → select your project (SiskelBot)
2. Go to **Settings** → **Domains**
3. Enter your domain (e.g. `assistant.yourdomain.com` or `yourdomain.com`) and click **Add**
4. Vercel will show the DNS records you need to create

### DNS setup

**Subdomain (e.g. `assistant.yourdomain.com`):**

| Type  | Name       | Value                                      |
|-------|------------|--------------------------------------------|
| CNAME | assistant  | `cname.vercel-dns.com` (or value Vercel shows) |

**Apex domain (e.g. `yourdomain.com`):**

| Type | Name | Value           |
|------|------|-----------------|
| A    | @    | `76.76.21.21`   |

Add these records in your registrar’s DNS management. **Use the exact values Vercel shows for your project**—they may differ slightly.

### SSL (HTTPS)

After DNS propagates (often minutes, up to 48 hours), Vercel automatically provisions a TLS certificate. HTTPS is enabled with no extra steps.

### Verify

- In **Vercel → Settings → Domains**, confirm the domain shows a green **Valid configuration** status
- Optional: use `vercel alias set <deployment-url> <your-domain>` via the [Vercel CLI](https://vercel.com/docs/cli) for programmatic aliasing

### More resources

- [Vercel: Add a domain](https://vercel.com/docs/domains/add-a-domain)
- [Vercel: Troubleshooting domains](https://vercel.com/docs/domains/troubleshooting)
- [Vercel: Working with SSL](https://vercel.com/docs/domains/working-with-ssl)
