# Credential Manager Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use godmode:task-runner to implement this plan task-by-task.

**Goal:** Add a reusable credential store so the same username/authType/secret can be linked to many SSH connections and updated in one place.

**Architecture:** New `CredentialStore` class mirrors `ConnectionStore`. Connections get an optional `credential_id` FK column (nullable, backward-compatible). At connect time the WS handler resolves the credential if set. A key-icon modal in the sidebar manages credentials; the connection modal gains a credential dropdown.

**Tech Stack:** Node.js 24 ESM, Express 5, better-sqlite3, AES-256-GCM (existing crypto.js), Vite/vanilla JS frontend.

---

## Task 1: CredentialStore — server/credentials.js

**Files:**
- Create: `server/credentials.js`
- Create: `tests/credentials.test.js`

**Step 1: Write the failing test**

Create `tests/credentials.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('credential store CRUD with encryption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-cred-'))
  try {
    const { CredentialStore } = await import('../server/credentials.js')
    const key = Buffer.alloc(32, 0x42)
    const store = new CredentialStore(join(dir, 'test.db'), key)

    // Create
    const id = store.create({ name: 'Home Lab Admin', username: 'admin', authType: 'password', secret: 's3cret' })
    assert.ok(id)

    // Read
    const cred = store.get(id)
    assert.equal(cred.name, 'Home Lab Admin')
    assert.equal(cred.username, 'admin')
    assert.equal(cred.secret, 's3cret')   // decrypted on read

    // List omits secret
    const all = store.list()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, id)
    assert.equal(all[0].secret, undefined)

    // Update
    store.update(id, { name: 'Renamed', secret: 'newpass' })
    const updated = store.get(id)
    assert.equal(updated.name, 'Renamed')
    assert.equal(updated.secret, 'newpass')

    // Delete
    store.delete(id)
    assert.equal(store.list().length, 0)

    store.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
```

**Step 2: Run test — expect failure (module not found)**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../server/credentials.js'`

**Step 3: Implement `server/credentials.js`**

```js
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { encrypt, decrypt } from './crypto.js'

export class CredentialStore {
  #db
  #key

  constructor(dbPath, key) {
    this.#key = key
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ name, username, authType = 'password', secret }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO credentials (id, name, username, auth_type, secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, username, authType, encrypt(secret, this.#key), now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM credentials WHERE id = ?').get(id)
    if (!row) return null
    return this.#deserialize(row)
  }

  list() {
    return this.#db
      .prepare('SELECT id, name, username, auth_type, created_at, updated_at FROM credentials ORDER BY name')
      .all()
      .map(row => ({
        id: row.id,
        name: row.name,
        username: row.username,
        authType: row.auth_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Credential ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE credentials
      SET name = ?, username = ?, auth_type = ?, secret = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.name, updated.username, updated.authType, encrypt(updated.secret, this.#key), now, id)
  }

  delete(id) {
    this.#db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
  }

  reencryptAll(newKey) {
    const rows = this.#db.prepare('SELECT id, secret FROM credentials').all()
    const update = this.#db.prepare('UPDATE credentials SET secret = ? WHERE id = ?')
    this.#db.transaction(() => {
      for (const row of rows) {
        update.run(encrypt(decrypt(row.secret, this.#key), newKey), row.id)
      }
    })()
    this.#key = Buffer.from(newKey)
  }

  close() {
    this.#db.close()
  }

  #deserialize(row) {
    return {
      id: row.id,
      name: row.name,
      username: row.username,
      authType: row.auth_type,
      secret: decrypt(row.secret, this.#key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
```

**Step 4: Run tests — expect pass**

```bash
npm test
```

Expected: all 19 tests pass.

**Step 5: Commit**

```bash
git add server/credentials.js tests/credentials.test.js
git commit -m "feat: add CredentialStore with AES-256-GCM encryption"
```

---

## Task 2: ConnectionStore migration — add credential_id column

**Files:**
- Modify: `server/store.js`

**Step 1: Add column migration + return credentialId in get/list/update**

In `server/store.js`, after the `CREATE TABLE IF NOT EXISTS` exec, add the migration:

```js
// Migrate: add credential_id column if absent
const cols = this.#db.pragma('table_info(connections)').map(c => c.name)
if (!cols.includes('credential_id')) {
  this.#db.exec('ALTER TABLE connections ADD COLUMN credential_id TEXT DEFAULT NULL')
}
```

Update `#deserialize` to include `credentialId`:

```js
#deserialize(row) {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    secret: decrypt(row.secret, this.#key),
    credentialId: row.credential_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

Update `list()` SELECT to include `credential_id`:

```js
.prepare('SELECT id, label, host, port, username, auth_type, credential_id, created_at, updated_at FROM connections ORDER BY label')
.all()
.map(row => ({
  id: row.id,
  label: row.label,
  host: row.host,
  port: row.port,
  username: row.username,
  authType: row.auth_type,
  credentialId: row.credential_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}))
```

Update `update()` to accept and persist `credentialId`:

```js
update(id, fields) {
  const existing = this.get(id)
  if (!existing) throw new Error(`Connection ${id} not found`)
  const updated = { ...existing, ...fields }
  const now = Date.now()
  this.#db.prepare(`
    UPDATE connections
    SET label = ?, host = ?, port = ?, username = ?, auth_type = ?, secret = ?, credential_id = ?, updated_at = ?
    WHERE id = ?
  `).run(
    updated.label, updated.host, updated.port, updated.username,
    updated.authType, encrypt(updated.secret, this.#key),
    updated.credentialId ?? null, now, id
  )
}
```

Update `create()` to accept `credentialId`:

```js
create({ label, host, port = 22, username, authType = 'password', secret, credentialId = null }) {
  const id = randomUUID()
  const now = Date.now()
  this.#db.prepare(`
    INSERT INTO connections (id, label, host, port, username, auth_type, secret, credential_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, label, host, port, username, authType, encrypt(secret, this.#key), credentialId, now, now)
  return id
}
```

**Step 2: Run tests — expect pass (migration is non-destructive)**

```bash
npm test
```

Expected: all 19 tests pass.

**Step 3: Commit**

```bash
git add server/store.js
git commit -m "feat: add credential_id column to connections (auto-migration)"
```

---

## Task 3: Server — CredentialStore wiring + API endpoints

**Files:**
- Modify: `server/index.js`

**Step 1: Import and instantiate CredentialStore**

At the top of `server/index.js`, add import:

```js
import { CredentialStore } from './credentials.js'
```

After `let store = null`, add:

```js
/** @type {CredentialStore|null} */
let credStore = null

function getCredStore() {
  if (!credStore && masterKey.isUnlocked()) {
    credStore = new CredentialStore(
      join(config.dataDir, 'credentials.db'),
      masterKey.getKey()
    )
  }
  return credStore
}

function closeCredStore() {
  if (credStore) { credStore.close(); credStore = null }
}

function requireCredStore(res) {
  const s = getCredStore()
  if (!s) { res.status(423).json({ error: 'Server locked' }); return null }
  return s
}
```

**Step 2: Update closeStore() to also close credStore**

```js
function closeStore() {
  if (store) { store.close(); store = null }
  closeCredStore()
}
```

**Step 3: Add credential API endpoints**

Add after the connection CRUD endpoints:

```js
// Credential CRUD
app.get('/api/credentials', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  res.json(s.list())
})

app.post('/api/credentials', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const { name, username, authType, secret } = req.body
  if (!name || !username || !secret) {
    return res.status(400).json({ error: 'name, username, and secret are required' })
  }
  if (authType && !['password', 'key'].includes(authType)) {
    return res.status(400).json({ error: 'authType must be "password" or "key"' })
  }
  const id = s.create({ name, username, authType: authType || 'password', secret })
  res.status(201).json({ id })
})

app.get('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const cred = s.get(req.params.id)
  if (!cred) return res.status(404).json({ error: 'Not found' })
  res.json(cred)
})

app.put('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  try {
    s.update(req.params.id, req.body)
    res.json({ ok: true })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

app.delete('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const connStore = getStore()
  if (connStore) {
    const refs = connStore.list().filter(c => c.credentialId === req.params.id)
    if (refs.length > 0) {
      return res.status(409).json({
        error: `Credential is used by ${refs.length} connection${refs.length !== 1 ? 's' : ''}. Unlink them first.`
      })
    }
  }
  s.delete(req.params.id)
  res.json({ ok: true })
})
```

**Step 4: Update WS connect handler to resolve credential**

In the `msg.type === 'connect'` block, after `const conn = s.get(connectionId)`, add credential resolution:

```js
let resolvedConn = conn
if (conn.credentialId) {
  const cs = getCredStore()
  const cred = cs?.get(conn.credentialId)
  if (cred) {
    resolvedConn = { ...conn, username: cred.username, authType: cred.authType, secret: cred.secret }
  }
}

try {
  sessionId = await sshManager.open({
    ...resolvedConn, ws, cols: cols ?? 80, rows: rows ?? 24,
  })
```

(Replace the existing `...conn` spread with `...resolvedConn`.)

**Step 5: Update change-password to reencrypt credentials**

In `POST /api/change-password`, after `if (s) s.reencryptAll(newKey)`, add:

```js
const cs = getCredStore()
if (cs) cs.reencryptAll(newKey)
```

**Step 6: Run tests — expect pass**

```bash
npm test
```

Expected: all 19 tests pass.

**Step 7: Commit**

```bash
git add server/index.js
git commit -m "feat: wire CredentialStore into server — API endpoints + WS resolution"
```

---

## Task 4: HTML — credentials modal + connection form dropdown

**Files:**
- Modify: `client/index.html`

**Step 1: Add key-icon button to sidebar header actions**

In the `.header-actions` div, add the credentials button before the scan button:

```html
<div class="header-actions">
  <button id="creds-btn" title="Manage credentials">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="15" r="4"/><path d="M12 15h8M16 12v6"/>
    </svg>
  </button>
  <button id="scan-btn" ...>
```

**Step 2: Add credentials modal**

Add after the scan modal and before the change-password modal:

```html
<!-- Credentials modal -->
<div id="creds-modal" class="hidden">
  <div class="modal-card creds-card">
    <h2>Credentials</h2>
    <ul id="creds-list" class="creds-list"></ul>
    <hr class="modal-divider">
    <h3 id="creds-form-title">Add Credential</h3>
    <form id="creds-form">
      <input type="hidden" name="id">
      <input name="name" placeholder="Name (e.g. Home Lab Admin)" required>
      <input name="username" placeholder="Username" required>
      <select name="authType">
        <option value="password">Password</option>
        <option value="key">Private Key</option>
      </select>
      <input name="secret" type="password" placeholder="Password or paste private key" required>
      <p id="creds-error" class="error hidden"></p>
      <div class="modal-actions">
        <button type="button" id="creds-cancel">Cancel</button>
        <button type="submit" id="creds-submit">Add</button>
      </div>
    </form>
  </div>
</div>
```

**Step 3: Add credential dropdown to connection modal**

At the top of `#conn-form`, before the label input, add:

```html
<select name="credentialId" id="cred-select">
  <option value="">— enter credentials below —</option>
</select>
<div id="inline-cred-fields">
  <input name="username" placeholder="Username">
  <select name="authType">
    <option value="password">Password</option>
    <option value="key">Private Key</option>
  </select>
  <input id="secret-field" name="secret" type="password" placeholder="Password or paste private key">
</div>
```

Remove the existing standalone `username`, `authType`, `secret` fields (they are now inside `#inline-cred-fields`).

**Step 4: Commit HTML**

```bash
git add client/index.html
git commit -m "feat: add credentials modal and credential dropdown to connection form (HTML)"
```

---

## Task 5: CSS — credentials modal styles

**Files:**
- Modify: `client/style.css`

**Step 1: Add styles**

Append to `client/style.css`:

```css
/* Credentials modal */
#creds-modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 200; }
.creds-card { width: 400px; max-height: 80vh; overflow-y: auto; }
.creds-list { list-style: none; margin-bottom: .75rem; }
.creds-list:empty::after { content: 'No credentials saved.'; display: block; color: var(--text-muted); font-size: .85rem; padding: .25rem 0; }
.cred-item { display: flex; align-items: center; gap: .5rem; padding: .4rem 0; border-bottom: 1px solid var(--surface2); font-size: .9rem; }
.cred-item:last-child { border-bottom: none; }
.cred-info { flex: 1; min-width: 0; }
.cred-name { display: block; }
.cred-username { display: block; font-size: .75rem; color: var(--text-muted); }
.cred-edit, .cred-delete { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 5px; font-size: .85rem; border-radius: 3px; flex-shrink: 0; }
.cred-edit:hover { color: #7ec8e3; }
.cred-delete:hover { color: var(--accent); }
.modal-divider { border: none; border-top: 1px solid var(--surface2); margin: .75rem 0; }
```

**Step 2: Run tests**

```bash
npm test
```

Expected: all 19 tests pass.

**Step 3: Commit**

```bash
git add client/style.css
git commit -m "feat: add CSS for credentials modal"
```

---

## Task 6: JS — credentials manager + connection modal wiring

**Files:**
- Modify: `client/main.js`

**Step 1: Add credentials state and DOM refs**

After `let connections = []` add:

```js
let credentials = []
```

After existing DOM refs, add:

```js
const credsModal = document.getElementById('creds-modal')
const credsList = document.getElementById('creds-list')
const credsForm = document.getElementById('creds-form')
const credsFormTitle = document.getElementById('creds-form-title')
const credsError = document.getElementById('creds-error')
const credSelect = document.getElementById('cred-select')
const inlineCredFields = document.getElementById('inline-cred-fields')
```

**Step 2: Add loadCredentials and renderCredentialList**

```js
// ── Credentials ───────────────────────────────────────────────────────────
async function loadCredentials() {
  credentials = await api.get('/api/credentials')
  renderCredentialList()
  renderCredentialDropdown()
}

function renderCredentialList() {
  credsList.innerHTML = ''
  for (const cred of credentials) {
    const li = document.createElement('li')
    li.className = 'cred-item'

    const info = document.createElement('div')
    info.className = 'cred-info'
    const nameSpan = document.createElement('span')
    nameSpan.className = 'cred-name'
    nameSpan.textContent = cred.name
    const userSpan = document.createElement('span')
    userSpan.className = 'cred-username'
    userSpan.textContent = cred.username
    info.appendChild(nameSpan)
    info.appendChild(userSpan)

    const editBtn = document.createElement('button')
    editBtn.className = 'cred-edit'
    editBtn.title = 'Edit'
    editBtn.textContent = '✎'
    editBtn.addEventListener('click', async () => {
      const full = await api.get(`/api/credentials/${cred.id}`)
      openCredForm(full)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'cred-delete'
    deleteBtn.title = 'Delete'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('click', async () => {
      const res = await fetch(`/api/credentials/${cred.id}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json()
        credsError.textContent = data.error
        credsError.classList.remove('hidden')
        return
      }
      credsError.classList.add('hidden')
      await loadCredentials()
    })

    li.appendChild(info)
    li.appendChild(editBtn)
    li.appendChild(deleteBtn)
    credsList.appendChild(li)
  }
}

function renderCredentialDropdown() {
  const current = credSelect.value
  // keep first placeholder option, rebuild the rest
  while (credSelect.options.length > 1) credSelect.remove(1)
  for (const cred of credentials) {
    const opt = document.createElement('option')
    opt.value = cred.id
    opt.textContent = `${cred.name} (${cred.username})`
    credSelect.appendChild(opt)
  }
  credSelect.value = current
  toggleInlineCredFields()
}

function toggleInlineCredFields() {
  inlineCredFields.style.display = credSelect.value ? 'none' : ''
}

credSelect.addEventListener('change', toggleInlineCredFields)
```

**Step 3: Add credentials modal open/close and form logic**

```js
document.getElementById('creds-btn').addEventListener('click', async () => {
  await loadCredentials()
  openCredForm(null)
  credsModal.classList.remove('hidden')
})

document.getElementById('creds-cancel').addEventListener('click', () => closeCredModal())
credsModal.addEventListener('click', (e) => { if (e.target === credsModal) closeCredModal() })

function closeCredModal() {
  credsModal.classList.add('hidden')
  openCredForm(null)
}

function openCredForm(cred) {
  credsForm.reset()
  credsError.classList.add('hidden')
  if (cred) {
    credsFormTitle.textContent = 'Edit Credential'
    credsForm.elements.id.value = cred.id
    credsForm.elements.name.value = cred.name
    credsForm.elements.username.value = cred.username
    credsForm.elements.authType.value = cred.authType
    credsForm.elements.secret.value = cred.secret
    document.getElementById('creds-submit').textContent = 'Save'
  } else {
    credsFormTitle.textContent = 'Add Credential'
    credsForm.elements.id.value = ''
    document.getElementById('creds-submit').textContent = 'Add'
  }
}

credsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  credsError.classList.add('hidden')
  const data = Object.fromEntries(new FormData(credsForm))
  const editingCredId = data.id
  delete data.id
  if (editingCredId) {
    await api.put(`/api/credentials/${editingCredId}`, data)
  } else {
    await api.post('/api/credentials', data)
  }
  await loadCredentials()
  openCredForm(null)
})
```

**Step 4: Update openModal to handle credentialId**

Replace the existing `openModal` function:

```js
function openModal(conn, prefill = null) {
  editingId = conn?.id ?? null
  modalTitle.textContent = conn ? 'Edit Connection' : 'New Connection'
  connForm.reset()
  credSelect.value = ''
  toggleInlineCredFields()
  const fill = conn ?? prefill
  if (fill) {
    Object.entries(fill).forEach(([k, v]) => {
      if (k === 'credentialId') {
        credSelect.value = v ?? ''
        toggleInlineCredFields()
        return
      }
      const el = connForm.elements[k]
      if (el) el.value = v
    })
  }
  modal.classList.remove('hidden')
  connForm.elements.label.focus()
}
```

**Step 5: Update connForm submit to include credentialId**

Replace the connForm submit handler body:

```js
connForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(connForm))
  data.port = parseInt(data.port, 10)
  // if a credential is linked, clear inline fields so server ignores them
  if (data.credentialId) {
    data.username = ''
    data.secret = ''
  } else {
    data.credentialId = null
  }
  if (editingId) {
    await api.put(`/api/connections/${editingId}`, data)
  } else {
    await api.post('/api/connections', data)
  }
  closeModal()
  await loadConnections()
})
```

**Step 6: Load credentials on init**

Update the init section at the bottom:

```js
loadConnections()
loadCredentials()
refreshAdmin()
setInterval(refreshAdmin, 15_000)
```

**Step 7: Run tests**

```bash
npm test
```

Expected: all 19 tests pass.

**Step 8: Commit**

```bash
git add client/main.js
git commit -m "feat: credential manager UI — modal, list, dropdown in connection form"
```

---

## Task 7: End-to-end Docker test + final push

**Step 1: Build and start**

```bash
docker compose build && docker compose up -d
```

**Step 2: Smoke test**

1. Visit `http://localhost:3000` — unlock
2. Click the key icon — credentials modal opens, shows "No credentials saved"
3. Add a credential: name "Test Admin", username "admin", password "secret"
4. Close modal, click New Connection — credential dropdown shows "Test Admin (admin)"
5. Select credential — username/authType/secret fields hide
6. Save connection with just label + host + credential selected
7. Edit the connection — credential dropdown pre-selected correctly
8. Open credentials modal, edit credential name — list updates
9. Try deleting credential while connection uses it — 409 error shown
10. Unlink connection (set dropdown to "— enter credentials below —"), save
11. Delete credential — succeeds

**Step 3: Stop container**

```bash
docker compose down
```

**Step 4: Final commit and push**

```bash
git push
```
