# Browser Tab — Design

**Date:** 2026-04-17
**Status:** Approved, awaiting implementation plan

## Goal

Add a "browser tab" to sshweb so the user can reach internal-infrastructure web UIs (Pi-hole, Portainer, Unraid/Synology, routers, NAS admin pages, etc.) from the same app as their SSH tabs. Scope intentionally limited to simple internal admin UIs — no heavy SPAs, no WebSockets, no public-internet browsing.

## Scope

**In scope (v1):**
- Open named saved bookmarks from a sidebar section, mirroring the SSH connection pattern.
- Ad-hoc URL bar in each web tab for following links / typing URLs.
- HTTP and HTTPS upstream targets on private IP ranges only (RFC1918 + loopback).
- Per-origin cookie handling (in-memory, per sshweb session, wiped on lock).
- Per-bookmark "ignore TLS errors" toggle (default strict); session-scoped TLS override for ad-hoc URLs via interstitial.
- Tab restore on page reload (URL only, not scroll/form state).
- Back / forward / refresh / URL chrome within each web tab.

**Out of scope (v1):**
- WebSocket proxying (Grafana live panels, Home Assistant, Proxmox console, etc.).
- Public-internet browsing.
- File downloads / uploads beyond what the iframe handles natively.
- Persistent cookie storage across restarts.
- Complex SPAs that compute URLs in JavaScript (known limitation of HTML-rewriting proxies).

## Approach

**Selected: Adopt [`unblocker`](https://www.npmjs.com/package/unblocker) as the proxy core.**

`unblocker` is a mature Node streaming proxy that already handles URL rewriting, charset normalization, streaming, and the `/proxy/<url>` URL scheme. Sshweb wraps it with its own middleware layer for auth, private-IP restriction, per-session cookie isolation, and per-bookmark TLS policy.

Alternatives considered and rejected:
- **Custom proxy from scratch** — too much surface area (HTML rewriting, charset handling, CSS `url()`, redirects with cookies) for a v1.
- **Headless Chromium streamed to tab** — overkill for scope A; ~300MB image bloat + CPU per tab.

## Architecture

```
Browser tab (iframe)
  ↕ HTTP(S) to sshweb origin
Express server
  ├─ /api/bookmarks          CRUD for saved web bookmarks
  ├─ /api/tabs               per-session open-tab state (restore)
  ├─ /api/tls-override       session-scoped "proceed anyway" on TLS fail
  └─ /proxy/<url>            unblocker pipeline
                              ├─ requireUnlockedSession
                              ├─ privateIpGuard (RFC1918 + loopback, DNS pinned)
                              ├─ tlsPolicyResolver (per-bookmark + per-session override)
                              ├─ sessionCookieJar (in-memory, keyed by sessionId+origin)
                              └─ unblocker (fetch upstream, rewrite HTML/CSS URLs)
Internal host (HTTP/HTTPS)
```

### New server modules
- `server/webproxy.js` — wires `unblocker` with sshweb middleware, mounts `/proxy`.
- `server/bookmarks.js` — SQLite CRUD for the `bookmarks` table.

### New client code
- Sidebar "Web" section (list, add/edit/delete, matching SSH connection UX).
- Web tab renderer (URL bar, back/forward/refresh, iframe).
- Tab restore on page load (`GET /api/tabs`, then reopen).

## Data model

New SQLite table, alongside existing `connections` and `credentials`:

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  ignore_tls    INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

No encryption on this table — URLs and labels are not secrets, same trust model as `connections`.

### In-memory state (server, per sshweb session)
- `cookieJars: Map<sessionId, Map<origin, tough-cookie.CookieJar>>` — wiped on lock / expiry.
- `openTabs: Map<sessionId, Array<{tabId, url}>>` — for tab restore.
- `tlsOverrides: Map<sessionId, Set<origin>>` — session-scoped "proceed anyway".

## Proxy request pipeline

Order (all run before `unblocker` touches the request):

1. **`requireUnlockedSession`** — reuses existing auth. Unauthenticated → 401 JSON or `/unlock` redirect.
2. **`privateIpGuard`** — RFC1918 + loopback only. For hostnames, resolve via `dns.lookup`, reject if any resolved address is public. Cache resolution ~60s. Pin the resolved IP for the lifetime of a page-load to prevent DNS rebinding. Rejections return a 403 HTML interstitial.
3. **`tlsPolicyResolver`** — attach `https.Agent({ rejectUnauthorized: false })` if the origin matches a bookmark with `ignore_tls=1` or is in the session-scoped override set.
4. **`sessionCookieJar`** — inject `Cookie` header from the per-session, per-origin jar on outbound; capture `Set-Cookie` on inbound. Strict origin isolation.
5. **`unblocker`** — upstream fetch + HTML/CSS URL rewriting + streaming back to the client.

### Non-GET methods
Pass through with body streaming (supported by `unblocker`). Covers login POSTs and typical admin-UI actions.

### WebSockets
Upgrade requests to `/proxy/*` return 501 and log. Out of scope for v1.

### Response sanitation
Strip `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` from upstream responses so the iframe renders. Intentional and scoped to `/proxy/*`.

## Frontend

### Sidebar
- New "Web" section below "Connections"
- `+` button → add bookmark form (label, URL, "ignore TLS errors" checkbox)
- Click bookmark → new web tab; hover icons for edit/delete

### Tab chrome
```
┌───────────────────────────────────────────────────────┐
│ [←] [→] [⟳]  [ https://192.168.1.10/login     ] [Go] │
├───────────────────────────────────────────────────────┤
│   <iframe src="/proxy/https://192.168.1.10/login">    │
└───────────────────────────────────────────────────────┘
```

- URL bar shows the **upstream** URL, not the `/proxy/...` form.
- On submit: client validates private-IP target, then navigates the iframe.
- Back/forward/refresh wrap `iframe.contentWindow.history` / `.location.reload()`.
- URL-sync on iframe `load`: decode the `/proxy/<url>` path back to upstream and update the URL bar.

### Tab restore
- `GET /api/tabs` on page load → reopen each.
- `POST /api/tabs` on open/close/navigate.

### TLS interstitial
Server returns a small HTML page on strict-TLS failure with "Proceed this session" / "Cancel". Proceed → `POST /api/tls-override` → reload iframe.

## Security

- All `/proxy/*` requests require an unlocked session.
- Private IP only; DNS pinned per page-load against rebinding.
- Cookies in-memory, per-session, wiped on lock/expiry/restart.
- Per-bookmark `ignore_tls`; ad-hoc URL-bar strict by default.
- Rate limit `/proxy/*` per session (~120 req/min) to bound runaway fetches.
- Log method/host/path/status at `debug`; never log bodies or cookie values.
- CSP stays same-origin; upstream frame-blocking headers stripped only within `/proxy/*`.

### Error responses

| Case | Behavior |
|---|---|
| Unauthenticated | 401 JSON or `/unlock` redirect |
| Public-IP target | 403 HTML interstitial |
| DNS failure | 502 HTML interstitial |
| Connection refused / 10s timeout | 502 HTML interstitial |
| TLS fail + strict | Interstitial with "Proceed this session" |
| Upstream 5xx | Passed through |
| WS upgrade to `/proxy/*` | 501 + log |
| Rate limit exceeded | 429 HTML interstitial |

## Admin panel additions

- Active web-tab count per session.
- "Clear web cookies" button (wipes jars without locking).

## Testing

### Unit
- `tests/bookmarks.test.js` — CRUD round-trip, URL parsing, `ignore_tls` persistence.
- `tests/webproxy.test.js` — middleware chain against a local fixture:
  - private-IP guard: allow 192.168.x.x, reject 8.8.8.8, reject DNS resolving to public IP
  - DNS rebinding: second resolution to a public IP within the same page-load rejected
  - TLS strict vs. `ignore_tls` against a self-signed fixture
  - cookie jar origin isolation; wipe on session end
  - `X-Frame-Options` / `frame-ancestors` stripping
  - 403 interstitial for public IP; 501 on WS upgrade

### Integration
- Local fixture Express app with login + dashboard on 127.0.0.1; drive login POST → cookie → dashboard GET via the proxy.

### Manual smoke
Document in this plan: add a bookmark to a real LAN admin UI, log in, navigate, lock sshweb, verify cookies gone on re-unlock.

## Rollout

- Single PR.
- New deps: `unblocker`, `tough-cookie` (if not transitive).
- Dockerfile unchanged.
- `.env.example` unchanged in v1.
- README: new "Web browser tab" section — bookmarks, private-IP scope, TLS caveat, scope-A limitations.
- CHANGELOG entry.

## Known limitations

- JS-computed URLs inside proxied pages may not go through the proxy (HTML/CSS rewriting only).
- No WebSocket support → live-updating dashboards won't update.
- Some sites enforce same-origin checks in JS or expect their real hostname; those won't work through `/proxy/...`.
- Cookie jar is per-session in RAM; restart means re-login to each admin UI.
