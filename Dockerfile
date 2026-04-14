# ── Stage 1: Build frontend ───────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY client/ client/
COPY vite.config.js ./
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

RUN addgroup -S sshweb && adduser -S sshweb -G sshweb

COPY package*.json ./
RUN npm install --omit=dev --omit=optional

COPY server/ server/
COPY --from=builder /app/dist dist/

RUN mkdir -p /data && chown sshweb:sshweb /data
VOLUME ["/data"]

USER sshweb

ENV PORT=3000 \
    DATA_DIR=/data \
    SESSION_TIMEOUT_MINUTES=60 \
    MAX_SESSIONS=10 \
    LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server/index.js"]
