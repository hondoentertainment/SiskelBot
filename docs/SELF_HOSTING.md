# Self-Hosting Guide

Deploy SiskelBot on your own infrastructure. This guide covers one-click platform deploys, manual VPS setup, SSL, backups, and monitoring.

## Platform Comparison

| Feature | Railway | Render | Fly.io | Heroku | VPS (Ubuntu) |
|---------|---------|--------|--------|--------|--------------|
| One-click deploy | Yes | Yes | No | Yes | No |
| Free tier | Yes (trial) | Yes | Yes | No | No |
| Persistent storage | Volume | Disk | Volume | Postgres addon | Full control |
| WebSocket support | Yes | Yes | Yes | Yes | Yes |
| Custom domains | Yes | Yes | Yes | Yes | Yes |
| Auto SSL | Yes | Yes | Yes | Yes | Let's Encrypt |
| Scaling | Horizontal | Horizontal | Multi-region | Horizontal | Manual |
| Docker support | Yes | Yes | Yes | Yes | Yes |
| Estimated cost | $5+/mo | $7+/mo | $3+/mo | $7+/mo | $5+/mo |

## One-Click Deploy

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/your-template?referralCode=siskelbot)

1. Click the button above
2. Set environment variables (`BACKEND`, `OPENAI_API_KEY` if using OpenAI)
3. Railway auto-detects Node.js and deploys

Config file: [`deploy/railway.json`](../deploy/railway.json)

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/your-org/SiskelBot)

1. Click the button above
2. Render reads the blueprint from `deploy/render.yaml`
3. Set any additional environment variables in the Render dashboard

Config file: [`deploy/render.yaml`](../deploy/render.yaml)

### Heroku

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/your-org/SiskelBot)

1. Click the button above
2. Heroku provisions PostgreSQL and Redis automatically
3. Configure `BACKEND` and API keys in the deploy form

Config file: [`deploy/heroku.json`](../deploy/heroku.json)

### Fly.io

Fly.io requires the CLI. See [Fly.io manual deploy](#flyio-manual-deploy) below.

Config file: [`deploy/fly.toml`](../deploy/fly.toml)

## Manual Platform Deploys

### Railway (CLI)

```bash
npm install -g @railway/cli
railway login
railway init
cp deploy/railway.json railway.json
railway up
```

### Render (CLI)

```bash
# Push to a GitHub repo, then connect it in the Render dashboard.
# Render auto-detects deploy/render.yaml as a Blueprint.
```

### Fly.io (Manual Deploy)

```bash
# Install the Fly CLI
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Copy the config
cp deploy/fly.toml fly.toml

# Launch (first time)
fly launch --no-deploy
fly secrets set BACKEND=openai OPENAI_API_KEY=sk-...

# Create a persistent volume for data/
fly volumes create siskelbot_data --size 1 --region iad

# Deploy
fly deploy

# Check status
fly status
fly logs
```

### Heroku (CLI)

```bash
# Install the Heroku CLI
# https://devcenter.heroku.com/articles/heroku-cli

heroku login
heroku create siskelbot
heroku addons:create heroku-postgresql:essential-0
heroku addons:create heroku-redis:mini

heroku config:set BACKEND=openai
heroku config:set OPENAI_API_KEY=sk-...
heroku config:set STORAGE_BACKEND=postgres
heroku config:set NODE_ENV=production

git push heroku main
```

## Manual VPS Deployment (Ubuntu/Debian)

### Prerequisites

- Ubuntu 22.04+ or Debian 12+
- 1 GB RAM minimum (2 GB recommended)
- Node.js 18+ installed
- A domain name (optional, for SSL)

### Step 1: Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node --version  # Should be 20.x
```

### Step 2: Clone and install

```bash
# Create a dedicated user
sudo useradd -m -s /bin/bash siskelbot
sudo su - siskelbot

# Clone the repository
git clone https://github.com/your-org/SiskelBot.git
cd SiskelBot

# Install production dependencies
npm ci --omit=dev
```

### Step 3: Configure environment

```bash
# Run the interactive setup wizard
node scripts/setup-wizard.mjs

# Or manually copy and edit .env
cp .env.example .env
nano .env
```

Key variables to set:

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND` | Yes | `ollama`, `vllm`, or `openai` |
| `OPENAI_API_KEY` | If using OpenAI | Your OpenAI API key |
| `API_KEY` | Recommended | Protects the chat completions endpoint |
| `ADMIN_API_KEY` | Recommended | Protects admin endpoints |
| `SESSION_SECRET` | If using OAuth | Random secret for sessions |
| `NODE_ENV` | Recommended | Set to `production` |

See [`.env.example`](../.env.example) for the full list of environment variables.

### Step 4: Set up as a systemd service

```bash
sudo tee /etc/systemd/system/siskelbot.service > /dev/null <<'EOF'
[Unit]
Description=SiskelBot
After=network.target

[Service]
Type=simple
User=siskelbot
WorkingDirectory=/home/siskelbot/SiskelBot
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/home/siskelbot/SiskelBot/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/siskelbot/SiskelBot/data

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable siskelbot
sudo systemctl start siskelbot

# Check status
sudo systemctl status siskelbot
sudo journalctl -u siskelbot -f
```

### Step 5: Reverse proxy with Nginx

```bash
sudo apt-get install -y nginx

sudo tee /etc/nginx/sites-available/siskelbot > /dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/siskelbot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## SSL/TLS with Let's Encrypt

### Install Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

### Obtain a certificate

```bash
sudo certbot --nginx -d your-domain.com
```

Certbot automatically configures Nginx for HTTPS and sets up auto-renewal.

### Verify auto-renewal

```bash
sudo certbot renew --dry-run
```

Certbot installs a systemd timer that renews certificates automatically. To verify:

```bash
sudo systemctl status certbot.timer
```

### Manual renewal

```bash
sudo certbot renew
sudo systemctl reload nginx
```

## Docker Deployment

For Docker-based deployments, see [docs/DOCKER](/docs/DOCKER) and [docs/DOCKER_COMPOSE](/docs/DOCKER_COMPOSE).

Quick start:

```bash
docker compose up -d
```

## Backup Strategy

### Automated backups

SiskelBot includes a built-in backup system. Configure it with these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_ADMIN_KEY` | (none) | API key to protect backup/restore endpoints |
| `BACKUP_MAX_RETAINED` | 7 | Maximum number of backups to keep |

### Create a backup

```bash
# Via API
curl -X POST http://localhost:3000/api/v1/backups \
  -H "x-admin-api-key: YOUR_ADMIN_KEY"

# Via CLI
node bin/siskelbot.js backup
```

### Schedule daily backups (cron)

```bash
# Add to crontab
crontab -e

# Daily backup at 2 AM
0 2 * * * curl -s -X POST http://localhost:3000/api/v1/backups \
  -H "x-admin-api-key: YOUR_ADMIN_KEY" >> /var/log/siskelbot-backup.log 2>&1
```

### Restore from backup

```bash
# List available backups
curl http://localhost:3000/api/v1/backups \
  -H "x-admin-api-key: YOUR_ADMIN_KEY"

# Restore a specific backup
curl -X POST http://localhost:3000/api/v1/backups/BACKUP_ID/restore \
  -H "x-admin-api-key: YOUR_ADMIN_KEY"
```

### Off-site backup

For production deployments, also back up the data directory to external storage:

```bash
# Rsync to a remote server
rsync -az /home/siskelbot/SiskelBot/data/ backup-server:/backups/siskelbot/

# Or upload to S3-compatible storage
aws s3 sync /home/siskelbot/SiskelBot/data/ s3://your-bucket/siskelbot-backup/
```

For PostgreSQL storage backends, use `pg_dump`:

```bash
pg_dump $DATABASE_URL > siskelbot-$(date +%Y%m%d).sql
```

## Monitoring Setup

### Health checks

SiskelBot exposes health endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /health/live` | Liveness probe (is the process running?) |
| `GET /health/ready` | Readiness probe (is the server ready to serve?) |

### Prometheus metrics

Enable metrics by setting `ENABLE_METRICS=1`. Scrape `GET /metrics` with Prometheus.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: siskelbot
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: /metrics
```

A Grafana dashboard template is available at [`grafana/`](../grafana/).

### OpenTelemetry

Enable tracing with:

```bash
OTEL_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTEL_SERVICE_NAME=siskel-bot
```

See the [`.env.example`](../.env.example) for the full set of OpenTelemetry variables.

### Simple uptime monitoring

If you do not use Prometheus, a simple cron-based health check:

```bash
# Check every 5 minutes, restart if unhealthy
*/5 * * * * curl -sf http://localhost:3000/health/live > /dev/null || sudo systemctl restart siskelbot
```

## Updating to New Versions

### Standard update

```bash
cd /home/siskelbot/SiskelBot

# Create a backup before updating
node bin/siskelbot.js backup

# Pull latest changes
git pull origin main

# Install updated dependencies
npm ci --omit=dev

# Run database migrations (if using SQLite or PostgreSQL)
node bin/siskelbot.js migrate

# Restart the service
sudo systemctl restart siskelbot

# Verify health
curl -s http://localhost:3000/health/live
```

### Zero-downtime update (multiple instances)

If running behind a load balancer with multiple instances:

1. Remove one instance from the load balancer
2. Update and restart that instance
3. Verify health, then re-add to the load balancer
4. Repeat for remaining instances

### Docker update

```bash
git pull origin main
docker compose build
docker compose up -d
```

### Rollback

If an update causes issues:

```bash
# Revert to the previous version
git checkout HEAD~1

# Reinstall dependencies
npm ci --omit=dev

# Restart
sudo systemctl restart siskelbot

# Restore data from backup if needed
node bin/siskelbot.js backup --restore
```
