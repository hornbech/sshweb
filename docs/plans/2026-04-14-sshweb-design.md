# sshweb — Design Document
**Date:** 2026-04-14  
**Status:** Approved

---

## Overview

A personal homelab web-based SSH terminal client. Runs in a single Docker container, accessed via a browser, served behind Nginx Proxy Manager with SSL/TLS termination. Features a connection manager with encrypted credential storage protected by a master password.

---

## Architecture

### Data Flow

```
Browser (xterm.js)
  ↕ WebSocket (ws://)
Express + ws server (Node.js)
  ↕ SSH2 stream (PTY)
Remote SSH server
```

### Project Structure

```
sshweb/
├── server/
│   ├── index.js          # Express + WebSocket server entry point
│   ├── ssh.js            # ssh2 connection manager
│   ├── store.js          # better-sqlite3 connection store (encrypted)
│   ├── crypto.js         # AES-256-GCM encrypt/decrypt helpers
│   └── config.js         # env-based configuration
├── client/
│   ├── index.html        # Single page app
│   ├── main.js           # xterm.js init, WebSocket client, UI logic
│   └── style.css         # Terminal + UI styling
├── data/                 # Mounted Docker volume
│   ├── connections.db    # AES-256-GCM encrypted SQLite DB
│   └── salt              # Argon2id salt (not secret, not a key)
├── Dockerfile            # Multi-stage: Vite build → Node runtime
├── docker-compose.yml
├── .env.example
├── Makefile
├── vite.config.js
└── package.json
```

---

## Connection Manager

Saved connections are stored in `data/connections.db` — a SQLite database with all secret fields encrypted at rest using AES-256-GCM.

### Connection Schema

```json
{
  "id": "uuid-v4",
  "label": "My Homelab Server",
  "host": "192.168.1.10",
  "port": 22,
  "username": "john",
  "authType": "password | key",
  "secret": "<AES-256-GCM encrypted: password or private key PEM>"
}
```

### UI

- Left sidebar lists saved connections by label
- "New Connection" button opens a form (label, host, port, username, auth type, secret)
- Clicking a saved connection opens a terminal tab immediately
- Each connection can be edited or deleted
- Admin panel in sidebar shows: uptime, version, lock status, active sessions with Kill buttons, and a "Lock Server" button

---

## Master Key & Security Model

### Key Derivation

- Algorithm: **Argon2id** (memory-hard, GPU-resistant)
- A random 32-byte salt is generated on first run and saved to `data/salt`
- The master password is **never stored anywhere** — only derived key is held in memory
- A short HMAC verification token is stored so incorrect passwords are rejected without attempting to decrypt

### Unlock Flow (Web UI)

1. Container starts → server enters **locked state**
2. All requests redirect to `/unlock`
3. User visits app in browser → enters master password
4. Server derives key via Argon2id → holds in memory → unlocks
5. App is fully accessible until container restarts
6. "Lock Server" button in admin panel clears key from memory without restarting

### Encryption

- Algorithm: **AES-256-GCM** (authenticated encryption)
- Each secret field is encrypted individually with a unique IV
- The in-memory derived key is used for all encrypt/decrypt operations

---

## Docker Setup

### Dockerfile (multi-stage)

- **Stage 1 (`builder`):** `node:24-alpine`, install all deps, run `vite build`
- **Stage 2 (`runtime`):** `node:24-alpine` slim, copy built frontend + server, `npm ci --omit=dev`, run as non-root user

### docker-compose.yml

```yaml
services:
  sshweb:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Nginx Proxy Manager

- Proxy host points at `http://sshweb:3000` (or host IP + port if not on same Docker network)
- SSL/TLS terminates at NPM — app runs plain HTTP inside the container
- WebSocket proxying must be enabled in NPM (toggle in Advanced tab)

---

## Configuration (`.env`)

```env
PORT=3000
DATA_DIR=/data
SESSION_TIMEOUT_MINUTES=60
MAX_SESSIONS=10
LOG_LEVEL=info        # trace | debug | info | warn | error
```

`.env.example` is committed to the repo. `.env` is gitignored.

---

## Observability & Logging

- **Library:** `pino` (JSON structured logs to stdout)
- **Dev:** `pino-pretty` for human-readable output
- **Viewed via:** `docker logs -f sshweb` or `make logs`
- Each SSH session gets a UUID correlation ID tracked across all log lines
- Log events: session open, session close, auth failure, server lock/unlock, errors

### Health Endpoint

`GET /health`

```json
{
  "status": "locked | ok",
  "version": "1.0.0",
  "uptime": 3600,
  "activeSessions": 2
}
```

---

## Graceful Shutdown

On `SIGTERM` (`docker compose down`):
1. Stop accepting new WebSocket connections
2. Send "server shutting down" notice to all active terminals
3. Wait up to 10s for sessions to close naturally
4. Force-close remaining sessions and exit

---

## Makefile — Operations

```makefile
start:         docker compose up -d
stop:          docker compose down
logs:          docker compose logs -f
restart:       docker compose restart
update:        docker compose build && docker compose up -d
backup:        cp -r ./data ./data.backup-$(shell date +%Y%m%d)
shell:         docker compose exec sshweb sh

audit:         npm audit
check-updates: npx npm-check-updates
upgrade-deps:  npx npm-check-updates -u && npm install && npm audit

maintain:
	@echo "=== npm audit ===" && npm audit
	@echo "=== outdated packages ===" && npx npm-check-updates
	@echo "=== rebuilding with latest base image ===" && docker compose build --pull && docker compose up -d
```

**Monthly maintenance routine:** `make maintain`

---

## Dependency Update Strategy

| Layer | Strategy |
|---|---|
| npm packages | `make check-updates` (read-only) → `make upgrade-deps` (apply) → rebuild |
| Node.js base image | Pinned to `node:24-alpine` major; patch updates pulled automatically on `docker compose build --pull` |
| Major Node.js version | Manual bump in Dockerfile when ready |
| Optional | Enable GitHub Dependabot or add `renovate.json` for automated PRs |

---

## Package Summary

| Package | Purpose |
|---|---|
| `express` | HTTP server + static frontend serving |
| `ws` | WebSocket server |
| `ssh2` | SSH client / PTY allocation |
| `argon2` | Argon2id master key derivation |
| `better-sqlite3` | Connection store (atomic writes, queryable) |
| `pino` + `pino-pretty` | Structured JSON logging |
| `uuid` | Session + connection IDs |
| `dotenv` | `.env` config loading |
| `vite` (devDep) | Frontend build + dev proxy |
| `xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` | Browser terminal (frontend) |

---

## References

- Architecture inspired by [billchurch/webssh2](https://github.com/billchurch/webssh2) (MIT)
- Terminal emulator: [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) (MIT)
- Compared against [butlerx/wetty](https://github.com/butlerx/wetty) (MIT) and [tsl0922/ttyd](https://github.com/tsl0922/ttyd) (MIT)
