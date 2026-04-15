# Changelog

All notable changes to sshweb are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Security

- **Brute-force protection** — `POST /api/unlock` is now rate-limited to 10 failed attempts per IP per 15 minutes (HTTP 429). Uses `express-rate-limit` with `trust proxy` enabled so the real client IP is used behind Nginx Proxy Manager.
- **CSRF guard on lock endpoint** — `POST /api/lock` rejects requests carrying a cross-origin `Origin` header (403 Forbidden), preventing a malicious page from locking the server via a browser-initiated request. Direct API calls without an `Origin` header (curl, scripts) are unaffected.
- **Security headers** — `helmet` middleware added; every response now includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Strict-Transport-Security`, and `Permissions-Policy`. `X-Powered-By: Express` header removed.
- **CSP configuration** — permits `'unsafe-inline'` styles (required by xterm.js inline DOM styling) and `blob:` worker sources (xterm.js web worker); all other sources restricted to `'self'`.
- **Version disclosure removed** — `GET /health` no longer returns the application version.

### Fixed

- **Docker bind-mount permissions on Linux** — added `entrypoint.sh` that `chown`s `/data` as root before dropping to the `sshweb` user via `su-exec`. Previously, Docker created `./data` as root on the host and the container's non-root user could not write the `salt`/`verify` files on first run.
- **Silent permission errors reported as "Invalid password"** — `POST /api/unlock` now distinguishes auth failures (401) from infrastructure errors (500 with message). File-system errors no longer surface as a misleading "Invalid password".
- **No first-run UX** — `GET /api/unlock` now returns `{ firstRun: bool }`. The unlock page detects first run and shows a "Set master password" form with a confirm field instead of "Enter your master password". A typo on first entry no longer permanently locks the store.

---

## [1.0.0] — 2026-04-14

Initial release.

### Added

**Core terminal**
- Web-based SSH terminal using xterm.js with full color, resize, and hyperlink support
- Multiple terminal tabs — open several SSH sessions simultaneously
- PTY allocation with `xterm-256color` terminal type
- Automatic terminal resize on browser window resize (ResizeObserver + FitAddon)
- WebSocket bridge between browser and SSH server (no socket.io — plain `ws`)

**Connection manager**
- Save named SSH connections (label, host, port, username, auth type, secret)
- Password and private key authentication types
- Click a saved connection to open an instant terminal tab
- Create, edit, and delete connections via modal UI
- Connection secrets never returned in list API — only decrypted on direct `GET /api/connections/:id`

**Security**
- AES-256-GCM encryption for all stored secrets (random IV per record, authenticated)
- Argon2id master key derivation (m=65536, t=3, p=1, 32-byte output)
- Master password never stored — Argon2id salt + HMAC verification token stored instead
- `timingSafeEqual` for HMAC comparison (no timing oracle)
- Master key zeroed in memory (`Buffer.fill(0)`) on lock
- `getKey()` returns a copy of the key buffer, not the internal reference

**Unlock flow**
- Server starts in locked state on every process start
- Web-based unlock page — no terminal access needed to unlock
- `POST /api/unlock` validates password, derives key, holds in memory
- `POST /api/lock` zeroes key and closes store — usable from admin panel
- Lock guard middleware returns `423 Locked` JSON for API requests, redirects browser clients to `/unlock`

**Admin panel**
- Server uptime display
- Active SSH sessions list with Kill button
- Lock Server button
- Polling every 15 seconds

**REST API**
- `GET /health` — `{status, version, uptime, activeSessions}`
- `POST /api/unlock` — unlock with master password
- `POST /api/lock` — lock server
- `GET /api/connections` — list connections (no secrets)
- `POST /api/connections` — create connection (with input validation)
- `PUT /api/connections/:id` — update connection
- `DELETE /api/connections/:id` — delete connection
- `GET /api/sessions` — list active SSH sessions
- `DELETE /api/sessions/:id` — kill SSH session

**Deployment**
- Multi-stage Docker build: Vite frontend build stage + Node.js runtime stage
- Non-root `sshweb` user in runtime image
- `/data` volume for persistent encrypted storage
- `docker-compose.yml` with health check, volume mount, env_file
- Health check `--start-period=15s` to avoid false-unhealthy on startup
- Nginx Proxy Manager compatible (plain HTTP inside container, TLS at NPM)

**Developer experience**
- `make start/stop/logs/restart/update/backup/shell` — operational commands
- `make test` — run all unit tests
- `make build/dev` — frontend build and dev server
- `make audit/check-updates/upgrade-deps` — dependency management
- `make maintain` — monthly one-command maintenance (audit + outdated + rebuild)
- `concurrently` for cross-platform `npm run dev` on Windows
- Vite dev server with `/api` and `/ws` proxy to Node backend
- `node --test` with proper glob quoting for Node 24 on Windows

**Test coverage**
- `tests/config.test.js` — 5 tests: type validation, finite numbers, valid log level
- `tests/crypto.test.js` — 6 tests: round-trip, random IV, tamper detection, key length guards, wrong key
- `tests/masterkey.test.js` — 1 test: full unlock/lock/verify cycle including wrong-password rejection
- `tests/server.test.js` — 5 tests: health locked, redirect, 400 on empty password

### Fixed (during implementation)

- `dev` script used `&` operator which is sequential in Windows CMD — replaced with `concurrently`
- `test` script glob not shell-expanded on Windows — added quotes for Node 24 built-in glob handling
- Express 5 wildcard route `app.get('*')` incompatible with path-to-regexp v8 — changed to `app.get('/{*splat}')`
- `.env.example` had `DATA_DIR=./data` which overrode Docker `ENV DATA_DIR=/data` — fixed to `/data`
- `ws.send()` unguarded against OPEN→CLOSING race — added `#safeSend()` helper in SshManager
- `getStore()` null dereference on locked API calls — added `requireStore()` helper with 423 response
- Async WebSocket message handler lacked top-level `try/catch` — added to prevent unhandled rejections
- Fallback unlock HTML form posted `urlencoded` but no parser was mounted — added `express.urlencoded()`
- `addTab()` used `innerHTML` with user-supplied label — replaced with safe DOM API
- `renderConnectionList()` and admin sessions panel used `innerHTML` — replaced with `textContent`
- `ConnectionStore.close()` not called on lock or shutdown — added `closeStore()` helper
- `data/verify` not in `.gitignore` — added alongside `data/salt`
- Stray `package.json;C` and `package-lock.json;C` Windows artifact directories — removed
- `uuid` npm package installed but unused — removed (`node:crypto` `randomUUID()` used instead)
- `docker-compose.yml` healthcheck missing `start_period` — added `start_period: 15s`

---

[1.0.0]: https://github.com/hornbech/sshweb/releases/tag/v1.0.0
