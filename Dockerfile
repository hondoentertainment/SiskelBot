# Phase 35: Docker & Container Support for SiskelBot
# Multi-stage build for production image

# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Build deps for optional better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

# Copy package files for dependency installation
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Production stage ---
FROM node:20-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 appgroup && \
    adduser -u 1000 -G appgroup -D appuser

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Create data directory and set ownership
RUN mkdir -p data && chown -R appuser:appgroup data

# Install curl for health check (lightweight)
RUN apk add --no-cache curl

# Switch to non-root user
USER appuser

EXPOSE 3000

ENV PORT=3000 NODE_ENV=production

# Health check: liveness probe (no external deps)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health/live || exit 1

CMD ["node", "server.js"]
