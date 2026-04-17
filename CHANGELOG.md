# Changelog

All notable changes to sshweb are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

- **Web browser tab** — browse internal admin UIs (Pi-hole, Portainer, router pages) via a built-in HTTP proxy. Bookmarks live in the sidebar alongside SSH connections; click to open a web tab with URL bar, back/forward/reload chrome, rendered in an iframe. Tabs restore on page reload. Per-session cookie isolation prevents upstream auth from leaking between sessions.
- `server/bookmarks.js` — `BookmarkStore` SQLite CRUD for web bookmarks (label, URL, ignoreTls flag).
- `server/netguard.js` — `isPrivateAddress()` and `classifyHost()` enforce RFC 1918 + loopback scope with DNS pinning against rebinding.
- `server/cookiejars.js` — `CookieJarStore` (retained for potential future use).
- `server/webproxy.js` — `createWebProxy()` wraps `unblocker` with private-IP guard, frame-header stripping, and permissive TLS for homelab gear.
- `GET/POST /api/bookmarks`, `GET/PUT/DELETE /api/bookmarks/:id` — bookmark CRUD endpoints.
- `POST /api/tls-override` — session-scoped TLS certificate override ("proceed anyway" for self-signed certs).
- `GET/PUT /api/tabs` — persist/restore open web tab URLs per session.
- `GET /api/admin/web` — web proxy metrics (open tabs, TLS overrides).
- Friendly error pages for proxy connection failures (ECONNREFUSED, timeout, DNS errors) instead of raw Express stack traces.
- Admin panel shows web proxy metrics.

### Security

- Proxy rejects any target that isn't RFC 1918 or loopback (DNS pinned per request against rebinding). TLS certificate verification is disabled for proxy requests — the private-IP guard is the trust boundary; homelab gear almost universally uses self-signed certs.
- Entire upstream `Content-Security-Policy`, `X-Frame-Options`, and related headers stripped from proxied responses. Sshweb's own helmet CSP is skipped for `/proxy/` routes so upstream JavaScript (eval, inline scripts) can execute. Non-proxy routes retain the full helmet CSP.
- Upstream cookies handled by unblocker's built-in cookie middleware — paths are rewritten to `/proxy/http://host:port/` so cookies are naturally scoped per target site in the browser. This allows JavaScript-heavy SPAs (e.g. Synology DSM) to read `document.cookie` for CSRF tokens and session management.
- Proxy state (TLS overrides, open tabs) wiped on session destroy/lock via `SessionManager.onClear` hook.

### Added

- **Credential manager** — key icon (🔑) button in the sidebar header opens a credentials modal. Save reusable credentials (name, username, auth type, secret) encrypted at rest with AES-256-GCM. Assign a credential to one or more connections via a dropdown in the connection form — the username/auth fields hide when a credential is selected. Credentials are resolved at connect time so updating a credential propagates to every linked server instantly.
- `server/credentials.js` — `CredentialStore` class mirrors `ConnectionStore`: in-memory encryption key, full CRUD, `reencryptAll` called alongside connections on master password change.
- `GET /api/credentials` — list all credentials (no secrets returned).
- `POST /api/credentials` — create credential.
- `GET /api/credentials/:id` — get single credential with decrypted secret.
- `PUT /api/credentials/:id` — update credential.
- `DELETE /api/credentials/:id` — delete credential; returns `409 Conflict` if any connection still references it.
- `connections` table gains a nullable `credential_id` column (auto-migrated on startup via `ALTER TABLE ADD COLUMN`). Fully backward-compatible — existing connections with `NULL` credential_id continue using inline fields.
- **Edit connection** — hover a connection in the sidebar to reveal a ✎ edit button. Fetches the full record (including decrypted secret) and opens the connection modal pre-filled.
- **Optional credentials on new connections** — username and secret are no longer required when saving a connection (e.g. when adding from scan results). Fill them in later via edit.
- **Ctrl+V paste into terminal** — paste event on the terminal textarea sends clipboard text to the SSH session. Right-click paste also works.
- **Network scanner** — magnifying glass button in the sidebar header opens a scan modal. Enter a subnet in CIDR notation (e.g. `10.0.0.0/24`) and click Scan. Results stream in live via Server-Sent Events as hosts with port 22 open are found. Each result shows the IP address and reverse-DNS hostname where available. Click **Add** on any result to pre-populate the new connection modal.
- `GET /api/scan/subnets` — returns the server's non-loopback IPv4 subnets for auto-fill (empty when running inside a Docker bridge network wider than /22).
- `GET /api/scan?subnet=x.x.x.x/n` — SSE endpoint. Accepts /22–/30 subnets (max 1022 hosts). Streams `{ip, hostname}` events per open host, `{progress}` per batch of 50, and `{done}` on completion. Rate-limited to 5 scans per IP per 5 minutes. Aborts cleanly when the client disconnects.

### Security

- **Session-based authentication** — unlocking the server now issues an HTTP-only, `SameSite=Strict`, `Secure` session cookie (64 hex chars, 32 random bytes). Every subsequent request — HTTP and WebSocket — is validated against an in-memory session store. Unauthenticated API requests receive `401 Unauthorized`; unauthenticated browser requests are redirected to `/unlock`. Sessions slide their expiry on each validated request and are cleared on lock or password change.
- `server/session.js` — `SessionManager` class: in-memory `Map<token, expiresAt>`, sliding 60-minute window (configurable via `SESSION_TIMEOUT_MINUTES`), periodic prune of expired tokens, `clear()` on lock. `getSessionToken(req)` parses the `session` cookie from the raw `Cookie` header (works for both Express and the raw Node `IncomingMessage` used by the WebSocket upgrade).
- **Brute-force protection** — `POST /api/unlock` is now rate-limited to 10 failed attempts per IP per 15 minutes (HTTP 429). Uses `express-rate-limit` with `trust proxy` enabled so the real client IP is used behind Nginx Proxy Manager.
- **CSRF guard on lock endpoint** — `POST /api/lock` rejects requests carrying a cross-origin `Origin` header (403 Forbidden), preventing a malicious page from locking the server via a browser-initiated request. Direct API calls without an `Origin` header (curl, scripts) are unaffected.
- **Security headers** — `helmet` middleware added; every response now includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Strict-Transport-Security`, and `Permissions-Policy`. `X-Powered-By: Express` header removed.
- **CSP configuration** — permits `'unsafe-inline'` styles (required by xterm.js inline DOM styling) and `blob:` worker sources (xterm.js web worker); all other sources restricted to `'self'`.
- **Version disclosure removed** — `GET /health` no longer returns the application version.

### Fixed

- **Web proxy broke JavaScript-heavy SPAs (e.g. Synology DSM)** — three issues combined to prevent complex admin UIs from loading through the proxy:
  1. Sshweb's own helmet CSP (`script-src 'self'`, no `unsafe-eval`) was applied to proxied responses, blocking unblocker's injected inline `<script>unblockerInit()</script>` and any upstream `eval()` usage. Fixed by skipping helmet for `/proxy/` routes.
  2. Server-side cookie capture deleted `Set-Cookie` headers from responses, preventing upstream JavaScript from reading `document.cookie` for CSRF tokens (e.g. Synology's SynoToken). Fixed by letting unblocker's built-in cookie middleware handle cookies natively — paths are rewritten and scoped per target site.
  3. Iframe `sandbox` attribute was too restrictive (missing `allow-modals`, blocked top navigation). Removed entirely since the proxy already restricts to private IPs.

- **SSH sessions disconnecting when idle** — the ssh2 client now sends SSH-level keepalive packets every 15 seconds (configurable via `SSH_KEEPALIVE_INTERVAL`), preventing the remote server or NAT/firewall from dropping idle connections. The WebSocket server also pings all clients every 30 seconds so reverse proxies (e.g. Nginx Proxy Manager) do not close idle WebSocket connections.

- **Terminal garbled Unicode / box-drawing characters** — SSH output was decoded with `atob()` producing a Latin-1 binary string; xterm.js misinterpreted multi-byte UTF-8 sequences. Fixed by passing a `Uint8Array` of raw bytes so xterm.js performs correct UTF-8 decoding.
- **Ctrl+V pasted text twice** — clipboard API handler and xterm's native paste event both fired, sending text twice. Replaced clipboard API approach with a `paste` event listener on `term.textarea` that calls `preventDefault()` before xterm sees it, sending text exactly once. No clipboard-read permission prompt required.
- **Session redirect loop** — `GET /unlock` redirected to `/` when `masterKey.isUnlocked()` was true, but the auth guard sent the browser back to `/unlock` when there was no valid session (e.g. expired cookie). Fixed by only redirecting to `/` when both conditions hold: server unlocked AND valid session.
- **Session cookie expired in ~3 seconds** — `maxAge` for Express cookies is milliseconds; the code was passing seconds (`SESSION_TIMEOUT_MINUTES * 60`). Fixed to `* 60 * 1000`.
- **Docker bind-mount permissions on Linux** — added `entrypoint.sh` that `chown`s `/data` as root before dropping to the `sshweb` user via `su-exec`. Previously, Docker created `./data` as root on the host and the container's non-root user could not write the `salt`/`verify` files on first run.
- **Credential not linked when creating a connection** — `POST /api/connections` was not extracting `credentialId` from the request body, so connections saved with a linked credential silently stored `NULL`. The 409 guard on credential deletion therefore never triggered. Fixed by destructuring and passing `credentialId` through the create call.
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
