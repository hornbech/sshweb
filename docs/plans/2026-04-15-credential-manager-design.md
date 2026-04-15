# Credential Manager Design

**Date:** 2026-04-15
**Status:** Approved

## Overview

A reusable credential store. Credentials (name, username, authType, secret) are saved separately and can be linked to one or more SSH connections. Updating a credential propagates to all connections that reference it at connect time.

## Data Model

### New `credentials` table

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | randomUUID |
| `name` | TEXT NOT NULL | display label, e.g. "Home Lab Admin" |
| `username` | TEXT NOT NULL | |
| `auth_type` | TEXT NOT NULL | `'password'` or `'key'` |
| `secret` | TEXT NOT NULL | AES-256-GCM encrypted |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

### `connections` table change

Add nullable column: `credential_id TEXT DEFAULT NULL`

- When `credential_id` is set, `username`/`auth_type`/`secret` on the connection row are ignored at connect time — the linked credential is used instead.
- When `NULL`, inline fields apply (fully backward compatible, no data migration needed).
- Migration: `ALTER TABLE connections ADD COLUMN credential_id TEXT DEFAULT NULL` on startup if column is absent.

## Server

### `server/credentials.js` — `CredentialStore` class

Mirrors `ConnectionStore` pattern:
- `create({ name, username, authType, secret })` → id
- `get(id)` → full record with decrypted secret
- `list()` → all records without secret
- `update(id, fields)`
- `delete(id)`
- `reencryptAll(newKey)` — called during password change

### New API endpoints (all session-guarded)

| Method | Path | Description |
|---|---|---|
| GET | `/api/credentials` | List all (no secrets) |
| POST | `/api/credentials` | Create |
| GET | `/api/credentials/:id` | Get single with decrypted secret |
| PUT | `/api/credentials/:id` | Update |
| DELETE | `/api/credentials/:id` | Delete; 409 if referenced by any connection |

### `ConnectionStore` changes

- Schema migration: add `credential_id` column if absent
- `get()` and `list()` return `credentialId`
- `update()` accepts `credentialId`

### WS connect handler (`server/index.js`)

After `s.get(connectionId)`: if `conn.credentialId` is set, fetch credential from `CredentialStore` and merge `username/authType/secret` before passing to `sshManager.open()`.

### Password change (`POST /api/change-password`)

Call `reencryptAll(newKey)` on both `ConnectionStore` and `CredentialStore`.

## Client

### Credentials modal

- Key icon button (`🔑`) in sidebar header actions (next to scan button)
- Modal lists saved credentials: name + username, with edit (✎) and delete (✕) buttons
- Inline add/edit form within the modal
- Delete blocked with 409 response shown as error if credential is in use

### Connection modal changes

- "Credential" `<select>` at top of form
  - First option: `— use fields below —` (inline mode)
  - Remaining options: saved credentials by name
- When a credential is selected: username/authType/secret fields hidden
- When "none": fields shown as normal (current behaviour)
- On load (edit mode): pre-select the linked credential if `credentialId` is set

### Delete guard

`DELETE /api/credentials/:id` returns 409 with count of referencing connections. Client shows this as an error message in the credentials modal.
