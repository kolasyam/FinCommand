# ═══════════════════════════════════════════════
#  FinCommand Pro — Dockerfile
#  Multi-stage: deps → build → production
# ═══════════════════════════════════════════════

# ── Stage 1: Install dependencies ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ── Stage 2: Production image ──
FROM node:20-alpine AS production
LABEL maintainer="FinCommand Pro"
LABEL description="CFO/CEO Financial Dashboard API"

# Security: create non-root user
RUN addgroup -S fincommand && adduser -S fincommand -G fincommand

WORKDIR /app

# Copy production deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY --chown=fincommand:fincommand . .

# Create required directories with correct permissions
RUN mkdir -p uploads logs && chown -R fincommand:fincommand uploads logs

# Drop to non-root
USER fincommand

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/v1/health || exit 1

CMD ["node", "server.js"]
