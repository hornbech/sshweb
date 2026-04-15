# sshweb

A personal homelab web-based SSH terminal. Open a browser, unlock with your master password, and SSH into any machine — no client software required.

![sshweb unlock screen](docs/images/placeholder.png)

---

## Features

- **Browser-based SSH terminal** — full xterm.js terminal emulator with color, resize, and hyperlink support
- **Connection manager** — save named connections; click to open an instant terminal tab; edit or delete from the sidebar
- **Credential manager** — save reusable credentials (username + auth + secret) and link them to multiple connections; update once, applies everywhere
- **Multiple tabs** — open several SSH sessions simultaneously, switch between them freely
- **Encrypted storage** — SSH secrets and credentials are AES-256-GCM encrypted at rest in SQLite; master password never stored
- **Master password** — Argon2id key derivation; the master password is never stored, only an HMAC verification token
- **Web unlock page** — container starts locked; unlock via browser on first visit
- **Network scanner** — scan a subnet for SSH servers (port 22); results stream live with reverse-DNS hostnames; one click to add a discovered host as a saved connection
- **Admin panel** — view active sessions, kill sessions, lock the server, monitor uptime
- **Docker deployment** — single container, multi-stage image, non-root runtime user
- **Nginx Proxy Manager ready** — plain HTTP inside the container; SSL/TLS terminates at NPM
- **Makefile operations** — `make start`, `make logs`, `make backup`, `make maintain`

---

## Quick Start

### Requirements

- Docker + Docker Compose
- (Optional) Nginx Proxy Manager for SSL/TLS

### 1. Clone

```bash
git clone https://github.com/hornbech/sshweb.git
cd sshweb
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` if needed (defaults are fine for most homelab setups):

```env
PORT=3000
DATA_DIR=/data
SESSION_TIMEOUT_MINUTES=60
MAX_SESSIONS=10
LOG_LEVEL=info
```

### 3. Start

```bash
make start
# or: docker compose up -d
```

### 4. Unlock

Visit `http://localhost:3000`. You will see the unlock page.

**First run:** The page shows a "Set master password" form with a confirm field. Choose a password — this becomes your master password. It initialises the encrypted store and is required on every subsequent server start.

**Subsequent runs:** The page shows the standard unlock form. Enter the same master password you chose on first run.

> The master password is never stored. If you forget it, the only recovery is to delete `data/salt` and `data/verify` (this wipes all saved connections) and start fresh.

---

## Network Scanner

Click the **magnifying glass** button in the sidebar header to open the scanner.

1. Enter your subnet in CIDR notation — e.g. `10.0.0.0/24`
2. Click **Scan** — results appear live as hosts with port 22 open are found
3. Each result shows the IP and reverse-DNS hostname (where available)
4. Click **Add** on any result to pre-populate the new connection form

> **Note:** The scanner runs inside the Docker container. On Linux it can reach your LAN through the Docker bridge. The subnet auto-fill is empty when the container's bridge network is wider than /22 — just type your subnet manually.

Accepted subnet sizes: `/22` to `/30` (up to 1022 hosts). Scans are rate-limited to 5 per IP per 5 minutes.

---

## Nginx Proxy Manager Setup

1. Add a **Proxy Host** pointing to `http://<host-ip>:3000`
2. In the **Advanced** tab, enable **WebSocket Support**
3. Add your SSL certificate on the **SSL** tab

The app handles HTTP internally; NPM provides HTTPS and the WSS upgrade.

---

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `DATA_DIR` | `/data` | Directory for encrypted DB and key files |
| `SESSION_TIMEOUT_MINUTES` | `60` | Idle session expiry; activity slides the window |
| `MAX_SESSIONS` | `10` | Maximum concurrent SSH sessions |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |

---

## Operations

### Daily

```bash
make start        # Start container (docker compose up -d)
make stop         # Stop container
make logs         # Tail container logs
make restart      # Restart container
make shell        # Open shell inside container
```

### Backup

```bash
make backup       # Copies ./data to ./data.backup-YYYYMMDD-HHMMSS
```

The `data/` directory contains everything needed to restore: the encrypted connections database, the Argon2id salt, and the HMAC verification token. **Back this directory up regularly.**

### Update

```bash
make update       # Rebuild image and redeploy (docker compose build && up -d)
```

### Monthly Maintenance

```bash
make maintain     # npm audit + check outdated packages + rebuild with latest base image
```

This single command:
1. Runs `npm audit` to check for vulnerabilities
2. Shows outdated npm packages (`npm-check-updates`)
3. Rebuilds the Docker image pulling the latest `node:24-alpine` patch

To apply package updates:

```bash
make upgrade-deps   # Bumps package.json versions + npm install + npm audit
make update         # Rebuild container with updated packages
```

---

## Development

### Prerequisites

- Node.js 24+

### Setup

```bash
npm install
cp .env.example .env
# Edit DATA_DIR=./data in .env for local dev
```

### Run

```bash
make dev      # Starts Node server (--watch) + Vite dev server concurrently
```

The Vite dev server proxies `/api` and `/ws` to the Node backend.

### Test

```bash
make test     # Runs all unit tests (node --test)
```

Tests cover: config validation, AES-256-GCM crypto, Argon2id master key lifecycle, and HTTP server routes.

### Build

```bash
make build    # Vite production build → dist/
```

---

## Security Model

### Credential Storage

SSH passwords and private keys are encrypted individually using **AES-256-GCM** before being written to the SQLite database. Each secret gets a unique random IV. The authentication tag prevents tampering.

### Master Key

The master password is processed through **Argon2id** (memory: 64 MB, iterations: 3, parallelism: 1) to derive a 256-bit encryption key. Parameters are intentionally expensive to resist brute-force attacks against a stolen database.

The derived key is held **only in memory** for the lifetime of the server process. On container restart, the key is gone — the server starts locked and requires the master password to be re-entered via the browser.

What is stored on disk:
- `data/salt` — random 32-byte Argon2id salt (not secret; required to reproduce the key)
- `data/verify` — HMAC-SHA256 of a fixed string keyed by the derived key (used to verify the correct password without storing the key)
- `data/connections.db` — SQLite database with AES-256-GCM encrypted secrets

**The master password itself is never written to disk.**

### HTTP Security Headers

Every response includes:

| Header | Value |
|--------|-------|
| `Content-Security-Policy` | Restricts scripts/styles/workers to `'self'`; blocks frames |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | Disables camera, microphone, geolocation |

`X-Powered-By` is suppressed.

### Session Authentication

Unlocking the server issues a **session cookie** (`HttpOnly`, `Secure`, `SameSite=Strict`, 64-char hex token derived from 32 random bytes). Every subsequent HTTP request and WebSocket upgrade is validated against an in-memory session store. Sessions use a sliding expiry window — each validated request resets the clock. Sessions are invalidated on lock or password change.

Unauthenticated API requests receive `401 Unauthorized`. Unauthenticated browser navigation is redirected to `/unlock`.

### Brute-Force Protection

`POST /api/unlock` is rate-limited to **10 failed attempts per IP per 15 minutes**. Subsequent attempts receive `429 Too Many Requests`. The real client IP is resolved via `X-Forwarded-For` when running behind a reverse proxy.

### CSRF Protection

`POST /api/lock` rejects requests with a cross-origin `Origin` header. This prevents a malicious page from locking the server via a browser-initiated request. Direct API calls without an `Origin` header are unaffected.

### Known Accepted Risks

- `POST /api/lock` has no password requirement — a direct (non-browser) caller can lock the server. Accepted trade-off for a single-user homelab; add network-level access control if this is a concern.
- `GET /api/connections` returns saved host labels and IPs while the server is unlocked. No secrets are included.

### Network

The app speaks plain HTTP internally. TLS is expected to be terminated by a reverse proxy (Nginx Proxy Manager, Traefik, Caddy). Do not expose port 3000 directly to the internet without TLS.

---

## Architecture

```
Browser (xterm.js)
  ↕ WebSocket (ws:// or wss:// via NPM)
Express + ws server (Node.js)
  ↕ SSH2 stream (PTY)
Remote SSH server
```

### Project Structure

```
sshweb/
├── server/
│   ├── config.js       # dotenv config with validation
│   ├── crypto.js       # AES-256-GCM encrypt/decrypt
│   ├── masterkey.js    # Argon2id key derivation + lock/unlock
│   ├── store.js        # Encrypted SQLite connection store
│   ├── ssh.js          # SSH session manager (ssh2)
│   └── index.js        # Express server + WebSocket handler
├── client/
│   ├── index.html      # Main app shell
│   ├── unlock.html     # Master password unlock page
│   ├── main.js         # xterm.js, tabs, connection manager, admin panel
│   └── style.css       # Dark theme
├── data/               # Persistent volume (mount here)
├── tests/              # Unit tests
├── docs/plans/         # Design and implementation documents
├── Dockerfile          # Multi-stage build
├── docker-compose.yml
├── Makefile
└── .env.example
```

---

## Troubleshooting

### "Server error" on first unlock (Linux)

The container entrypoint automatically `chown`s `/data` to the `sshweb` user before starting. If you see a 500 error instead of a successful first-run unlock, check container logs:

```bash
make logs
```

A permission error on `/data` will appear in the log. Ensure the bind-mount path is accessible and restart with `make start`.

### Forgot master password

There is no recovery. Delete `data/salt` and `data/verify` to reset. This also deletes all saved connections (the encrypted database is now unreadable without the original salt).

### Port already in use

```bash
# Change PORT in .env
PORT=3001
make restart
```

### Container marked unhealthy immediately

The health check has a 15-second start period. If the container is still unhealthy after 15 seconds, check logs:

```bash
make logs
```

### WebSocket not connecting behind NPM

Ensure **WebSocket Support** is enabled in the Nginx Proxy Manager proxy host Advanced tab.

---

## License

MIT
