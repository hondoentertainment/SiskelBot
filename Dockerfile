# Phase 35: Docker & Container Support for SiskelBot
# Multi-stage build for production image

# --- Build stage ---
FROM node:25-alpine AS builder
WORKDIR /app

# Build deps for optional better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

# Copy package files for dependency installation
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Production stage ---
FROM node:25-alpine

LABEL org.opencontainers.image.title="SiskelBot" \
      org.opencontainers.image.description="Realtime streaming assistant proxy for Ollama, vLLM, or OpenAI" \
      org.opencontainers.image.source="https://github.com/hondoentertainment/SiskelBot" \
      org.opencontainers.image.vendor="hondoentertainment"

WORKDIR /app

# Install curl for health check and create data dir in one layer
RUN apk add --no-cache curl && mkdir -p data

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY client/ ./client/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
COPY plugins/ ./plugins/

# Set ownership for data directory
RUN chown -R node:node data

USER node

EXPOSE 3000

ENV PORT=3000 NODE_ENV=production

# Health check: liveness probe (no external deps)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health/live || exit 1

CMD ["node", "server.js"]
